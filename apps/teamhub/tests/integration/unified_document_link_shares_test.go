package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestUnifiedDocumentLinkShareLifecycle(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	service := document.NewWithObjectStore(pool, objects)
	owner := document.LinkSharePrincipal{AccountID: "account_document_a"}
	input := document.SetLinkShareInput{Principal: owner, DocumentID: "document_human_a", Role: "viewer"}
	created, err := service.SetLinkShare(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if created.Token == "" || created.Version != 1 {
		t.Fatalf("missing link capability or version")
	}
	digest := sha256.Sum256([]byte(created.Token))
	var matches bool
	if err := db.QueryRowContext(ctx, `SELECT link_share_token_sha256=$1 FROM documents WHERE link_share_id=$2`, digest[:], created.ID).Scan(&matches); err != nil || !matches {
		t.Fatalf("digest stored=%v error=%v", matches, err)
	}
	access, err := service.ResolveLinkShare(ctx, created.Token)
	if err != nil || access.Role != "viewer" || access.DocumentID != input.DocumentID {
		t.Fatalf("access=%+v error=%v", access, err)
	}

	input.Role, input.ExpectedVersion = "editor", 1
	updated, err := service.SetLinkShare(ctx, input)
	if err != nil || updated.Token != "" || updated.Version != 2 {
		t.Fatalf("updated=%+v error=%v", updated, err)
	}
	access, err = service.ResolveLinkShare(ctx, created.Token)
	if err != nil || access.Role != "editor" {
		t.Fatalf("access=%+v error=%v", access, err)
	}
	if _, err := service.SetLinkShare(ctx, input); !errors.Is(err, document.ErrConflict) {
		t.Fatalf("stale update error=%v", err)
	}

	input.ExpectedVersion, input.Reset = 2, true
	reset, err := service.SetLinkShare(ctx, input)
	if err != nil || reset.Token == "" || reset.Token == created.Token {
		t.Fatalf("reset error=%v", err)
	}
	if _, err := service.ResolveLinkShare(ctx, created.Token); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("old link after reset error=%v", err)
	}
	if err := service.RevokeLinkShare(ctx, document.RevokeLinkShareInput{Principal: owner, DocumentID: input.DocumentID, ExpectedVersion: reset.Version}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ResolveLinkShare(ctx, reset.Token); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("revoked link error=%v", err)
	}
	var documentEvents int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_events WHERE document_id=$1 AND event_type='document.link_share.updated' AND resource_kind='link_share' AND resource_id=$2`, input.DocumentID, created.ID).Scan(&documentEvents); err != nil || documentEvents != 4 {
		t.Fatalf("documentEvents=%d error=%v", documentEvents, err)
	}
}

func TestUnifiedDocumentLinkShareManagementAuthority(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	service := document.NewWithObjectStore(pool, objects)
	input := document.SetLinkShareInput{Principal: document.LinkSharePrincipal{AgentID: "agent_document_a"}, DocumentID: "document_human_a", Role: "viewer"}
	// The Agent manages the link as its Human does, even through a viewer Binding.
	if _, err := db.ExecContext(ctx, `UPDATE document_context_bindings SET role='viewer',access_epoch=access_epoch+1,updated_at=clock_timestamp() WHERE id='binding_semantic_apply'`); err != nil {
		t.Fatal(err)
	}
	link, err := service.SetLinkShare(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	input.ExpectedVersion = link.Version
	if err := service.Trash(ctx, document.TrashDocumentInput{AccountID: "account_document_a", DocumentID: "document_human_a"}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ResolveLinkShare(ctx, link.Token); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("trashed document link error=%v", err)
	}
	var linkStatus string
	var linkVersion int
	if err := db.QueryRowContext(ctx, `SELECT link_share_status,link_share_version FROM documents WHERE link_share_id=$1`, link.ID).Scan(&linkStatus, &linkVersion); err != nil || linkStatus != "revoked" || linkVersion != int(link.Version)+1 {
		t.Fatalf("trash must durably revoke link: status=%s version=%d error=%v", linkStatus, linkVersion, err)
	}
}

func TestUnifiedDocumentLinkShareDownloadUsesDocumentTitle(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	export := func(_ context.Context, input document.ExportRuntimeRequest) (document.ExportRuntimeResult, error) {
		body := []byte("# Shared document\n")
		digest := sha256.Sum256(body)
		return document.ExportRuntimeResult{
			MediaType:         "text/markdown",
			Bytes:             body,
			SizeBytes:         int64(len(body)),
			SHA256:            hex.EncodeToString(digest[:]),
			CompleteAssetIDs:  []string{},
			CompleteThreadIDs: []string{},
			Warnings:          []string{},
		}, nil
	}
	service := document.NewWithRuntime(pool, documentRuntimeStub{export: export}, objects)
	owner := document.LinkSharePrincipal{AccountID: "account_document_a"}

	link, err := service.SetLinkShare(ctx, document.SetLinkShareInput{
		Principal:  owner,
		DocumentID: "document_human_a",
		Role:       "viewer",
	})
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name  string
		title string
		want  string
	}{
		{name: "ascii title without extension", title: "WIN015-DOC-TITLE", want: "WIN015-DOC-TITLE.md"},
		{name: "ascii title with extension", title: "WIN015-DOC-TITLE.md", want: "WIN015-DOC-TITLE.md"},
		{name: "utf8 cjk title", title: "\u4e2d\u6587\u6587\u6863", want: "\u4e2d\u6587\u6587\u6863.md"},
	} {
		t.Run("native/"+tc.name, func(t *testing.T) {
			if _, err := db.ExecContext(ctx, `UPDATE documents SET title=$1 WHERE id='document_human_a'`, tc.title); err != nil {
				t.Fatal(err)
			}
			downloaded, err := service.DownloadLinkFile(ctx, link.Token)
			if err != nil {
				t.Fatalf("DownloadLinkFile(%q): %v", tc.title, err)
			}
			if downloaded.Filename != tc.want || downloaded.Name != tc.want {
				t.Fatalf("native link download filename=%q name=%q want %q", downloaded.Filename, downloaded.Name, tc.want)
			}
		})
	}

	t.Run("ordinary document renamed from generic filename", func(t *testing.T) {
		body := []byte("plain text content")
		object, err := objects.Put(ctx, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		sha := hex.EncodeToString(object.SHA256[:])
		if _, err := db.ExecContext(ctx, `INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status
		) VALUES('document_ordinary_share','tenant_document_a','WIN015-DOC-TITLE.md','plain_text',
			'actor_human_a','human','actor_human_a','human','active')`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO document_versions(
			id,tenant_id,document_id,version_number,filename,representation_format,media_type,
			size_bytes,sha256,content_object_id,source,created_by_actor_id
		) VALUES('version_ordinary_share','tenant_document_a','document_ordinary_share',1,
			'document.md','plain_text','text/markdown',$1,$2,$3,'ordinary_upload','actor_human_a')`,
			len(body), sha, object.Key); err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `UPDATE documents SET current_version_id='version_ordinary_share' WHERE id='document_ordinary_share'`); err != nil {
			t.Fatal(err)
		}
		ordinaryLink, err := service.SetLinkShare(ctx, document.SetLinkShareInput{
			Principal:  owner,
			DocumentID: "document_ordinary_share",
			Role:       "viewer",
		})
		if err != nil {
			t.Fatal(err)
		}
		downloaded, err := service.DownloadLinkFile(ctx, ordinaryLink.Token)
		if err != nil {
			t.Fatal(err)
		}
		if downloaded.Filename != "WIN015-DOC-TITLE.md" {
			t.Fatalf("ordinary link download filename=%q want %q", downloaded.Filename, "WIN015-DOC-TITLE.md")
		}
	})
}
