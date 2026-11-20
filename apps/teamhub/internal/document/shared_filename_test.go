package document

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestResolveSharedDownloadFilename(t *testing.T) {
	longCJK := strings.Repeat("\u4e2d", 100)
	for _, tc := range []struct {
		name   string
		title  string
		stored string
		want   string
	}{
		{name: "native ascii title without extension", title: "WIN015-DOC-TITLE", stored: "latest.md", want: "WIN015-DOC-TITLE.md"},
		{name: "native ascii title with extension", title: "WIN015-DOC-TITLE.md", stored: "latest.md", want: "WIN015-DOC-TITLE.md"},
		{name: "native ascii title with uppercase extension", title: "WIN015-DOC-TITLE.MD", stored: "latest.md", want: "WIN015-DOC-TITLE.MD"},
		{name: "renamed ordinary document", title: "WIN015-DOC-TITLE.md", stored: "document.md", want: "WIN015-DOC-TITLE.md"},
		{name: "native utf8 cjk title without extension", title: "\u4e2d\u6587\u6587\u6863", stored: "latest.md", want: "\u4e2d\u6587\u6587\u6863.md"},
		{name: "native utf8 cjk title with extension", title: "\u4e2d\u6587\u6587\u6863.md", stored: "latest.md", want: "\u4e2d\u6587\u6587\u6863.md"},
		{name: "mixed ascii and utf8 cjk title", title: "WIN015 \u6d4b\u8bd5\u6807\u9898", stored: "latest.md", want: "WIN015 \u6d4b\u8bd5\u6807\u9898.md"},
		{name: "ordinary utf8 title preserves pdf extension", title: "\u9879\u76ee\u62a5\u544a", stored: "upload.pdf", want: "\u9879\u76ee\u62a5\u544a.pdf"},
		{name: "neutralizes separators and control characters", title: "Q3 / Q4\\Plan\x00\t\n2026", stored: "latest.md", want: "Q3 - Q4-Plan 2026.md"},
		{name: "blank title falls back to stored filename", title: "   ", stored: "shared.txt", want: "shared.txt"},
		{name: "dotdot title falls back to stored filename", title: "..", stored: "report.pdf", want: "report.pdf"},
		{name: "extensionless document keeps title", title: "README", stored: "README", want: "README"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveSharedDownloadFilename(tc.title, tc.stored)
			if got != tc.want {
				t.Fatalf("resolveSharedDownloadFilename(%q, %q) = %q, want %q", tc.title, tc.stored, got, tc.want)
			}
			if strings.ContainsAny(got, "/\\\x00") {
				t.Fatalf("resolved filename %q contains disallowed path characters", got)
			}
		})
	}

	got := resolveSharedDownloadFilename(longCJK, "latest.md")
	if len(got) > maxSourceFilenameBytes || !utf8.ValidString(got) || !strings.HasSuffix(got, ".md") {
		t.Fatalf("overlong UTF-8 filename = %q (len=%d, valid=%v)", got, len(got), utf8.ValidString(got))
	}
}
