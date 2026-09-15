import type {
  UploadSession,
  UploadedFile,
} from "./types";

const TOKEN_KEY = "security_sample_access_token";

const UPLOAD_API_URL = (
  import.meta.env.VITE_UPLOAD_API_URL ??
  import.meta.env.VITE_API_URL ??
  ""
).replace(/\/$/, "");

const DEFAULT_AUTH_API_URL =
  "https://security-ui-chat8gpt20180625-dev.apps.rm1.0a51.p1.openshiftapps.com";

const AUTH_API_URL = (
  import.meta.env.VITE_AUTH_API_URL ??
  DEFAULT_AUTH_API_URL
).replace(/\/$/, "");

export interface AuthUser {
  id: number | string;
  name: string;
  email: string;
  role: string;
  createdAt?: string;
}

export interface AuthResult {
  accessToken: string;
  user: AuthUser;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function normalizeToken(
  token: string | null,
): string | null {
  if (!token) {
    return null;
  }

  const normalized = token
    .replace(/^Bearer\s+/i, "")
    .trim();

  return normalized || null;
}

export const tokenStore = {
  get(): string | null {
    return normalizeToken(
      sessionStorage.getItem(TOKEN_KEY),
    );
  },

  set(token: string): void {
    const normalized = normalizeToken(token);

    if (!normalized) {
      throw new Error(
        "Cannot store an empty access token.",
      );
    }

    sessionStorage.setItem(
      TOKEN_KEY,
      normalized,
    );
  },

  clear(): void {
    sessionStorage.removeItem(TOKEN_KEY);
  },

  exists(): boolean {
    return Boolean(this.get());
  },
};

/**
 * Headers for public JSON endpoints such as login
 * and signup.
 */
function jsonHeaders(): HeadersInit {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

/**
 * Headers for protected JSON endpoints.
 *
 * This throws before sending the request if the
 * frontend has no access token.
 */
function requiredAuthHeaders(
  contentType = true,
): HeadersInit {
  const token = tokenStore.get();

  if (!token) {
    throw new ApiError(
      "Authentication token is missing. " +
        "Please log in again.",
      401,
    );
  }

  return {
    Accept: "application/json",

    ...(contentType
      ? {
          "Content-Type": "application/json",
        }
      : {}),

    Authorization: `Bearer ${token}`,
  };
}

async function parseResponse<T>(
  response: Response,
): Promise<T> {
  const text = await response.text();
  let body: unknown = text;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // Preserve non-JSON responses.
    }
  }

  if (!response.ok) {
    if (response.status === 401) {
      tokenStore.clear();
    }

    const defaultMessage =
      response.status === 401
        ? "Your login session is missing, invalid, " +
          "or expired. Please log in again."
        : response.status === 403
          ? "You are authenticated but do not have " +
            "permission to perform this operation."
          : `${response.status} ${response.statusText}`;

    const message =
      typeof body === "object" &&
      body !== null &&
      "message" in body
        ? String(
            (body as { message: unknown }).message,
          )
        : String(body || defaultMessage);

    throw new ApiError(
      message,
      response.status,
    );
  }

  return body as T;
}

export async function authenticate(
  mode: "login" | "signup",
  input: {
    name?: string;
    email: string;
    password: string;
  },
): Promise<AuthResult> {
  /*
   * Do not send an old token to login or signup.
   */
  tokenStore.clear();

  const response = await fetch(
    `${AUTH_API_URL}/api/auth/${mode}`,
    {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(input),
    },
  );

  const result =
    await parseResponse<AuthResult>(response);

  if (!result.accessToken) {
    throw new ApiError(
      "Authentication succeeded but no access " +
        "token was returned.",
      500,
    );
  }

  /*
   * Important: save the token immediately so that
   * createSession() and uploadFile() can use it.
   */
  tokenStore.set(result.accessToken);

  return result;
}

export async function currentUser():
Promise<AuthUser> {
  const response = await fetch(
    `${AUTH_API_URL}/api/users/me`,
    {
      method: "GET",
      headers: requiredAuthHeaders(),
    },
  );

  return parseResponse<AuthUser>(response);
}

export async function createSession(input: {
  folderName: string;
  expectedFiles: number;
  expectedBytes: number;
  validForHours: number;
}): Promise<UploadSession> {
  const response = await fetch(
    `${UPLOAD_API_URL}/api/upload-sessions`,
    {
      method: "POST",
      headers: requiredAuthHeaders(),
      body: JSON.stringify(input),
    },
  );

  return parseResponse<UploadSession>(response);
}

export function uploadFile(
  sessionId: string,
  file: File,
  relativePath: string,
  onProgress: (percent: number) => void,
): {
  promise: Promise<UploadedFile>;
  abort: () => void;
} {
  const request = new XMLHttpRequest();

  const form = new FormData();
  form.append(
    "relativePath",
    relativePath,
  );
  form.append(
    "file",
    file,
    file.name,
  );

  const promise = new Promise<UploadedFile>(
    (resolve, reject) => {
      const token = tokenStore.get();

      if (!token) {
        reject(
          new ApiError(
            "Authentication token is missing. " +
              "Please log in again.",
            401,
          ),
        );

        return;
      }

      request.open(
        "POST",
        `${UPLOAD_API_URL}` +
          `/api/upload-sessions/` +
          `${encodeURIComponent(sessionId)}` +
          `/files`,
      );

      /*
       * Headers must be set after request.open().
       */
      request.setRequestHeader(
        "Authorization",
        `Bearer ${token}`,
      );

      request.setRequestHeader(
        "Accept",
        "application/json",
      );

      /*
       * Do not manually set Content-Type here.
       * The browser must generate the multipart
       * boundary for FormData.
       */

      request.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.round(
            (event.loaded / event.total) * 100,
          );

          onProgress(percent);
        }
      };

      request.onload = () => {
        let body: unknown =
          request.responseText;

        if (request.responseText) {
          try {
            body = JSON.parse(
              request.responseText,
            );
          } catch {
            // Preserve non-JSON responses.
          }
        }

        if (
          request.status >= 200 &&
          request.status < 300
        ) {
          resolve(body as UploadedFile);
          return;
        }

        if (request.status === 401) {
          tokenStore.clear();

          reject(
            new ApiError(
              "Your login session is invalid or " +
                "expired. Please log in again.",
              401,
            ),
          );

          return;
        }

        if (request.status === 403) {
          reject(
            new ApiError(
              "You are authenticated but do not " +
                "have permission to upload files.",
              403,
            ),
          );

          return;
        }

        const message =
          typeof body === "object" &&
          body !== null &&
          "message" in body
            ? String(
                (
                  body as {
                    message: unknown;
                  }
                ).message,
              )
            : String(
                body ||
                  `Upload failed with HTTP ` +
                    `${request.status}`,
              );

        reject(
          new ApiError(
            message,
            request.status,
          ),
        );
      };

      request.onerror = () => {
        reject(
          new ApiError(
            "Network error while uploading file.",
            0,
          ),
        );
      };

      request.onabort = () => {
        reject(
          new ApiError(
            "Upload cancelled.",
            0,
          ),
        );
      };

      request.send(form);
    },
  );

  return {
    promise,
    abort: () => request.abort(),
  };
}

export function logout(): void {
  tokenStore.clear();
}