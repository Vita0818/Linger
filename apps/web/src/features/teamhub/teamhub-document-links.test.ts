import { fetchDouble, sentRequests } from "./teamhub-client-test-support";
import { expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createHttpTeamHubClient } from "./teamhub-client";
import { parseSharedDocumentFilename } from "./teamhub-document-links";
import { requestBodyText, requestUrlText } from "@linger/service-kit";

it("starts content and access reads together and cancels content when access fails", async () => {
  let denyAccess!: (response: Response) => void;
  let contentSignal: AbortSignal | undefined;
  const fetchRequest = vi.fn<typeof fetch>().mockImplementation(
    fetchDouble((url, init) => {
      if (url.endsWith("/resolve"))
        return new Promise((resolve) => {
          denyAccess = resolve;
        });
      contentSignal = init.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        contentSignal?.addEventListener(
          "abort",
          () => reject(contentSignal?.reason),
          { once: true },
        );
      });
    }),
  );
  const client = createHttpTeamHubClient({
    baseUrl: "https://web.test/",
    fetchRequest,
  });
  const pending = client.documentLinks.download(`doc_link_${"a".repeat(43)}`);
  const rejected = expect(pending).rejects.toMatchObject({ status: 404 });
  const startedTogether = (await sentRequests(fetchRequest)).length === 2;
  denyAccess(
    Response.json(
      { error: { code: "NOT_FOUND", message: "Link unavailable" } },
      { status: 404 },
    ),
  );
  await rejected;
  expect(startedTogether).toBe(true);
  expect(contentSignal?.aborted).toBe(true);
});

it("reads a link through POST bodies, verifies content, and rejects revoked access", async () => {
  const token = `doc_link_${"a".repeat(43)}`;
  const content = new TextEncoder().encode("shared content");
  const fetchRequest = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        link_id: "link-1",
        document_id: "doc-1",
        tenant_id: "tenant-1",
        role: "editor",
        version: 1,
      }),
    )
    .mockResolvedValueOnce(
      new Response(content, {
        headers: {
          "Content-Type": "text/plain",
          "X-Document-Id": "doc-1",
          "X-Document-Version-Id": "version-1",
          "X-Document-Filename": btoa("shared.txt"),
          "X-Document-Representation-Format": "plain_text",
          "X-Document-Read-Only": "false",
          "X-Content-Sha256": bytesToHex(sha256(content)),
        },
      }),
    )
    .mockResolvedValue(
      Response.json(
        { error: { code: "NOT_FOUND", message: "Link unavailable" } },
        { status: 404 },
      ),
    );
  const client = createHttpTeamHubClient({
    baseUrl: "https://web.test/",
    fetchRequest,
  });
  const result = await client.documentLinks.download(token);
  expect(fetchRequest.mock.contexts).toEqual([undefined, undefined]);
  expect(result).toMatchObject({
    documentId: "doc-1",
    versionId: "version-1",
    filename: "shared.txt",
    readOnly: false,
    access: { role: "editor" },
  });
  for (const [url, init] of await sentRequests(fetchRequest)) {
    expect(requestUrlText(url)).not.toContain(token);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(requestBodyText(init?.body))).toEqual({ token });
  }
  expect(requestUrlText((await sentRequests(fetchRequest))[1]?.[0])).toBe(
    "https://web.test/v0/shared-documents/content",
  );
  await expect(client.documentLinks.download(token)).rejects.toMatchObject({
    status: 404,
  });
});

it("manages link policies with explicit versions and treats missing policy as disabled", async () => {
  const fetchRequest = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(
        { error: { code: "NOT_FOUND", message: "Not found" } },
        { status: 404 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({
        id: "link-1",
        document_id: "doc-1",
        role: "viewer",
        status: "active",
        version: 1,
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const client = createHttpTeamHubClient({
    baseUrl: "https://web.test/",
    fetchRequest,
  });
  expect(await client.documentLinks.get("doc-1")).toBeNull();
  await client.documentLinks.set("doc-1", {
    role: "viewer",
    expected_version: 0,
    reset: false,
  });
  await client.documentLinks.revoke("doc-1", { expected_version: 1 });
  expect(
    (await sentRequests(fetchRequest)).map(([, init]) => init?.method),
  ).toEqual(["GET", "PUT", "DELETE"]);
});

function encodeBase64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

it.each([
  ["ASCII title", "WIN015-DOC-TITLE.md"],
  ["UTF-8 CJK title", "\u4e2d\u6587\u6587\u6863.md"],
  ["mixed ASCII and UTF-8 title", "WIN015-\u6d4b\u8bd5\u6807\u9898.md"],
])("decodes %s from unpadded X-Document-Filename", async (_label, title) => {
  const token = `doc_link_${"b".repeat(43)}`;
  const content = new TextEncoder().encode("# Body\n");
  const fetchRequest = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        link_id: "link-1",
        document_id: "doc-1",
        tenant_id: "tenant-1",
        role: "viewer",
        version: 1,
      }),
    )
    .mockResolvedValueOnce(
      new Response(content, {
        headers: {
          "Content-Type": "text/markdown",
          "X-Document-Id": "doc-1",
          "X-Document-Version-Id": "version-1",
          "X-Document-Filename": encodeBase64UrlUtf8(title),
          "X-Document-Representation-Format": "markdown",
          "X-Document-Read-Only": "true",
          "X-Content-Sha256": bytesToHex(sha256(content)),
        },
      }),
    );
  const client = createHttpTeamHubClient({
    baseUrl: "https://web.test/",
    fetchRequest,
  });
  const result = await client.documentLinks.download(token);
  expect(result.filename).toBe(title);
});

it.each([
  [
    "RFC 5987 UTF-8 filename* over ASCII fallback",
    `attachment; filename="document.md"; filename*=UTF-8''${encodeURIComponent("\u4e2d\u6587\u6587\u6863.md")}`,
    "\u4e2d\u6587\u6587\u6863.md",
  ],
  [
    "ASCII Content-Disposition filename",
    'attachment; filename="WIN015-DOC-TITLE.md"',
    "WIN015-DOC-TITLE.md",
  ],
])(
  "falls back to Content-Disposition for %s when X-Document-Filename is absent",
  async (_label, disposition, expected) => {
    const token = `doc_link_${"c".repeat(43)}`;
    const content = new TextEncoder().encode("# Body\n");
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          link_id: "link-1",
          document_id: "doc-1",
          tenant_id: "tenant-1",
          role: "viewer",
          version: 1,
        }),
      )
      .mockResolvedValueOnce(
        new Response(content, {
          headers: {
            "Content-Type": "text/markdown",
            "Content-Disposition": disposition,
            "X-Document-Id": "doc-1",
            "X-Document-Version-Id": "version-1",
            "X-Document-Representation-Format": "markdown",
            "X-Document-Read-Only": "true",
            "X-Content-Sha256": bytesToHex(sha256(content)),
          },
        }),
      );
    const client = createHttpTeamHubClient({
      baseUrl: "https://web.test/",
      fetchRequest,
    });
    const result = await client.documentLinks.download(token);
    expect(result.filename).toBe(expected);
  },
);

it.each([
  [
    "empty X-Document-Filename falls back to Content-Disposition",
    {
      "X-Document-Filename": "",
      "Content-Disposition": 'attachment; filename="fallback.md"',
    },
    "fallback.md",
  ],
  [
    "whitespace X-Document-Filename falls back to RFC 5987 Content-Disposition",
    {
      "X-Document-Filename": "   ",
      "Content-Disposition": `attachment; filename="document.md"; filename*=UTF-8''${encodeURIComponent("\u4e2d\u6587.md")}`,
    },
    "\u4e2d\u6587.md",
  ],
  [
    "malformed base64url X-Document-Filename without Content-Disposition returns null",
    {
      "X-Document-Filename": "not!valid!base64",
    },
    null,
  ],
  [
    "truncated base64url (length mod 4 === 1) without Content-Disposition returns null",
    {
      "X-Document-Filename": "A",
    },
    null,
  ],
  [
    "misplaced base64url padding without Content-Disposition returns null",
    {
      "X-Document-Filename": "YQ==YQ==",
    },
    null,
  ],
  [
    "invalid UTF-8 bytes in X-Document-Filename without Content-Disposition returns null",
    {
      "X-Document-Filename": "__4",
    },
    null,
  ],
  [
    "malformed base64url X-Document-Filename falls back to Content-Disposition",
    {
      "X-Document-Filename": "not!valid",
      "Content-Disposition": 'attachment; filename="recovered.md"',
    },
    "recovered.md",
  ],
  [
    "invalid UTF-8 X-Document-Filename falls back to Content-Disposition",
    {
      "X-Document-Filename": "__4",
      "Content-Disposition": 'attachment; filename="recovered.md"',
    },
    "recovered.md",
  ],
  [
    "quoted ASCII filename containing filename*= cannot be spoofed",
    {
      "Content-Disposition": `attachment; filename="report; filename*=UTF-8''spoof.md"`,
    },
    "report; filename*=UTF-8''spoof.md",
  ],
  [
    "quoted ASCII filename with escaped quote before spoofed filename*=",
    {
      "Content-Disposition": `attachment; filename="say \\"hi\\"; filename*=UTF-8''spoof.md"`,
    },
    `say "hi"; filename*=UTF-8''spoof.md`,
  ],
  [
    "quoted ASCII filename ending with escaped backslash does not swallow real filename*=",
    {
      "Content-Disposition": `attachment; filename="a\\\\"; filename*=UTF-8''real.md`,
    },
    "real.md",
  ],
  [
    "quoted filename with backslash and semicolon",
    {
      "Content-Disposition": `attachment; filename="file.a\\\\b; c"`,
    },
    "file.a\\b; c",
  ],
  [
    "earlier parameter quoted value containing filename*= is ignored",
    {
      "Content-Disposition": `attachment; note="x; filename*=UTF-8''spoof.md"; filename="real.md"`,
    },
    "real.md",
  ],
  [
    "unterminated quote does not leak leading quote into token fallback",
    {
      "Content-Disposition": 'attachment; filename="unterminated',
    },
    null,
  ],
  [
    "unterminated quote with trailing parameter returns null",
    {
      "Content-Disposition":
        'attachment; filename="unterminated; filename=other.md',
    },
    null,
  ],
  [
    "unterminated quote ending with lone backslash returns null",
    {
      "Content-Disposition": 'attachment; filename="trailing\\',
    },
    null,
  ],
  [
    "quoted filename* is ignored in favor of filename",
    {
      "Content-Disposition": `attachment; filename="fallback.md"; filename*="UTF-8''quoted.md"`,
    },
    "fallback.md",
  ],
  [
    "invalid RFC 5987 percent-encoding falls back to ASCII filename",
    {
      "Content-Disposition":
        "attachment; filename=\"fallback.md\"; filename*=UTF-8''%ZZinvalid.md",
    },
    "fallback.md",
  ],
  [
    "invalid RFC 5987 lone percent sign falls back to ASCII filename",
    {
      "Content-Disposition":
        "attachment; filename=\"100%.md\"; filename*=UTF-8''100%.md",
    },
    "100%.md",
  ],
  [
    "invalid RFC 5987 UTF-8 byte sequence falls back to ASCII filename",
    {
      "Content-Disposition":
        "attachment; filename=\"fallback.md\"; filename*=UTF-8''%C0%AF.md",
    },
    "fallback.md",
  ],
  [
    "non-UTF-8 RFC 5987 charset falls back to ASCII filename",
    {
      "Content-Disposition":
        "attachment; filename=\"rates.pdf\"; filename*=ISO-8859-1''%A3%20rates.pdf",
    },
    "rates.pdf",
  ],
  [
    "percent-encoded percent sign and UTF-8 in RFC 5987",
    {
      "Content-Disposition":
        "attachment; filename=\"100%.md\"; filename*=UTF-8''100%25%20%E4%B8%AD.md",
    },
    "100% \u4e2d.md",
  ],
  [
    "RFC 5987 with language tag",
    {
      "Content-Disposition":
        "attachment; filename=\"fallback.md\"; filename*=utf-8'en'hello%20world.md",
    },
    "hello world.md",
  ],
  [
    "trailing dot in RFC 5987 non-ASCII filename",
    {
      "Content-Disposition": `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent("\u4e2d\u6587.")}`,
    },
    "\u4e2d\u6587.",
  ],
  [
    "trailing dot and dot names in quoted filename",
    {
      "Content-Disposition": 'attachment; filename="foo."',
    },
    "foo.",
  ],
  [
    "unquoted token filename",
    {
      "Content-Disposition": "attachment; filename=plain-report.md",
    },
    "plain-report.md",
  ],
])("parseSharedDocumentFilename handles %s", (_label, headerMap, expected) => {
  expect(parseSharedDocumentFilename(new Headers(headerMap))).toBe(expected);
});

it("rejects raw CRLF in X-Document-Filename and falls back to Content-Disposition", () => {
  const headerMap = new Map<string, string>([
    ["x-document-filename", "YQ\r\n=="],
    ["content-disposition", 'attachment; filename="safe.md"'],
  ]);
  const headers = {
    get(name: string) {
      return headerMap.get(name.toLowerCase()) ?? null;
    },
  } as unknown as Headers;
  expect(parseSharedDocumentFilename(headers)).toBe("safe.md");
});

it("falls back to Content-Disposition during download when X-Document-Filename is empty", async () => {
  const token = `doc_link_${"d".repeat(43)}`;
  const content = new TextEncoder().encode("# Body\n");
  const fetchRequest = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        link_id: "link-1",
        document_id: "doc-1",
        tenant_id: "tenant-1",
        role: "viewer",
        version: 1,
      }),
    )
    .mockResolvedValueOnce(
      new Response(content, {
        headers: {
          "Content-Type": "text/markdown",
          "Content-Disposition":
            'attachment; filename="fallback-from-empty.md"',
          "X-Document-Filename": "",
          "X-Document-Id": "doc-1",
          "X-Document-Version-Id": "version-1",
          "X-Document-Representation-Format": "markdown",
          "X-Document-Read-Only": "true",
          "X-Content-Sha256": bytesToHex(sha256(content)),
        },
      }),
    );
  const client = createHttpTeamHubClient({
    baseUrl: "https://web.test/",
    fetchRequest,
  });
  const result = await client.documentLinks.download(token);
  expect(result.filename).toBe("fallback-from-empty.md");
});
