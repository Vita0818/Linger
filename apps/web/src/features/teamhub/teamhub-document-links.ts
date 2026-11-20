import type { components } from "@linger/wire-contracts/teamhub-public/types";
import { translate } from "@/i18n/language";
import {
  readBoundedArtifactContent,
  runBoundedArtifactDownload,
} from "./teamhub-artifact-download";
import {
  teamHubData as data,
  teamHubDone as done,
  type TeamHubApi,
} from "./teamhub-api";
import { TeamHubError } from "./teamhub-error";
import { teamHubExtrasMessages } from "./teamhub-extras.messages";
import type { TeamHubArtifactContent } from "./teamhub-types";

export type DocumentLinkPolicy = components["schemas"]["DocumentLinkShare"];
export type SharedDocumentContent = TeamHubArtifactContent & {
  documentId: string;
  versionId: string;
  filename: string;
  representationFormat: string;
  readOnly: boolean;
  access: components["schemas"]["DocumentLinkAccess"];
};
export interface TeamHubDocumentLinks {
  get(documentId: string): Promise<DocumentLinkPolicy | null>;
  set(
    documentId: string,
    input: components["schemas"]["SetDocumentLinkShare"],
  ): Promise<DocumentLinkPolicy>;
  revoke(
    documentId: string,
    input: components["schemas"]["RevokeDocumentLinkShare"],
  ): Promise<void>;
  download(token: string, signal?: AbortSignal): Promise<SharedDocumentContent>;
}

export function createTeamHubDocumentLinks(
  api: TeamHubApi,
): TeamHubDocumentLinks {
  return {
    async get(documentId) {
      try {
        return await data(
          api.GET("/v0/documents/{documentId}/link-share", {
            params: { path: { documentId } },
          }),
        );
      } catch (error) {
        if (error instanceof TeamHubError && error.status === 404) return null;
        throw error;
      }
    },
    set: (documentId, body) =>
      data(
        api.PUT("/v0/documents/{documentId}/link-share", {
          params: { path: { documentId } },
          body,
        }),
      ),
    revoke: (documentId, body) =>
      done(
        api.DELETE("/v0/documents/{documentId}/link-share", {
          params: { path: { documentId } },
          body,
        }),
      ),
    download(token, externalSignal) {
      return runBoundedArtifactDownload(
        { signal: externalSignal },
        async (downloadSignal) => {
          const controller = new AbortController();
          const signal = AbortSignal.any([downloadSignal, controller.signal]);
          try {
            const [access, { response }] = await Promise.all([
              data(
                api.POST("/v0/shared-documents/resolve", {
                  body: { token },
                  signal,
                }),
              ),
              api.POST("/v0/shared-documents/content", {
                body: { token },
                parseAs: "stream",
                signal,
                credentials: "omit",
                cache: "no-store",
                redirect: "error",
              }),
            ]);
            if (response.status === 202)
              throw new Error(
                translate(teamHubExtrasMessages.sharedFilePreparing),
              );
            const content = await readBoundedArtifactContent(response, {
              signal,
            });
            const documentId = response.headers.get("X-Document-Id");
            const versionId = response.headers.get("X-Document-Version-Id");
            const filename = parseSharedDocumentFilename(response.headers);
            const representationFormat = response.headers.get(
              "X-Document-Representation-Format",
            );
            if (
              documentId !== access.document_id ||
              !versionId ||
              !filename ||
              !representationFormat ||
              content.sha256 !== response.headers.get("X-Content-Sha256")
            )
              throw new Error(
                translate(teamHubExtrasMessages.sharedFileIntegrityFailed),
              );
            return {
              ...content,
              documentId,
              versionId,
              filename,
              representationFormat,
              readOnly: response.headers.get("X-Document-Read-Only") === "true",
              access,
            };
          } finally {
            controller.abort();
          }
        },
      );
    },
  };
}

export function parseSharedDocumentFilename(headers: Headers): string | null {
  const encodedName = headers.get("X-Document-Filename");
  if (encodedName !== null) {
    const decoded = decodeBase64UrlUtf8(encodedName);
    if (decoded !== null) return decoded;
  }
  return parseContentDispositionFilename(headers.get("Content-Disposition"));
}

function decodeBase64UrlUtf8(encoded: string): string | null {
  const trimmed = encoded.trim();
  if (!trimmed || /[^A-Za-z0-9\-_=]/.test(trimmed)) return null;
  const standard = trimmed.replaceAll("-", "+").replaceAll("_", "/");
  const remainder = standard.length % 4;
  if (remainder === 1) return null;
  const padded =
    remainder === 0 ? standard : standard + "=".repeat(4 - remainder);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function isHeaderWhitespace(character: string | undefined): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\r" ||
    character === "\n"
  );
}

function decodeRfc5987Value(raw: string): string | null {
  const firstQuote = raw.indexOf("'");
  const secondQuote = firstQuote >= 0 ? raw.indexOf("'", firstQuote + 1) : -1;
  if (firstQuote <= 0 || secondQuote <= firstQuote) return null;
  const charset = raw.slice(0, firstQuote).toLowerCase();
  const encodedValue = raw.slice(secondQuote + 1);
  if ((charset !== "utf-8" && charset !== "utf8") || encodedValue.length === 0)
    return null;
  try {
    const decoded = decodeURIComponent(encodedValue);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const firstSemicolon = header.indexOf(";");
  if (firstSemicolon < 0) return null;

  let index = firstSemicolon + 1;
  let extendedFilename: string | null = null;
  let fallbackFilename: string | null = null;

  while (index < header.length) {
    while (
      index < header.length &&
      (isHeaderWhitespace(header[index]) || header[index] === ";")
    ) {
      index += 1;
    }
    if (index >= header.length) break;

    const nameStart = index;
    while (
      index < header.length &&
      header[index] !== "=" &&
      header[index] !== ";" &&
      !isHeaderWhitespace(header[index])
    ) {
      index += 1;
    }
    const name = header.slice(nameStart, index).toLowerCase();

    while (index < header.length && isHeaderWhitespace(header[index])) {
      index += 1;
    }
    if (index >= header.length || header[index] !== "=") {
      while (index < header.length && header[index] !== ";") index += 1;
      continue;
    }
    index += 1;

    while (index < header.length && isHeaderWhitespace(header[index])) {
      index += 1;
    }
    if (index >= header.length) break;

    if (header[index] === '"') {
      index += 1;
      let value = "";
      let closed = false;
      while (index < header.length) {
        const character = header[index];
        if (character === "\\") {
          index += 1;
          if (index < header.length) {
            value += header[index];
            index += 1;
          }
          continue;
        }
        if (character === '"') {
          closed = true;
          index += 1;
          break;
        }
        value += character;
        index += 1;
      }
      if (!closed) break;

      while (index < header.length && isHeaderWhitespace(header[index])) {
        index += 1;
      }
      const validDelimiter = index >= header.length || header[index] === ";";
      if (!validDelimiter) {
        while (index < header.length && header[index] !== ";") index += 1;
        continue;
      }
      if (name === "filename" && fallbackFilename === null && value.length > 0)
        fallbackFilename = value;
      continue;
    }

    const valueStart = index;
    while (
      index < header.length &&
      header[index] !== ";" &&
      !isHeaderWhitespace(header[index])
    ) {
      index += 1;
    }
    const rawValue = header.slice(valueStart, index);
    while (index < header.length && isHeaderWhitespace(header[index])) {
      index += 1;
    }
    const validDelimiter = index >= header.length || header[index] === ";";
    if (!validDelimiter) {
      while (index < header.length && header[index] !== ";") index += 1;
      continue;
    }
    if (rawValue.length === 0 || rawValue.includes('"')) continue;

    if (name === "filename*" && extendedFilename === null) {
      extendedFilename = decodeRfc5987Value(rawValue);
    } else if (name === "filename" && fallbackFilename === null) {
      fallbackFilename = rawValue;
    }
  }

  return extendedFilename ?? fallbackFilename;
}
