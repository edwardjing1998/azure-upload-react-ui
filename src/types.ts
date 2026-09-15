export type SessionStatus = "CREATED" | "UPLOADING" | "COMPLETED" | "FAILED";

export interface UploadSession {
  sessionId: string;
  folderName: string;
  status: SessionStatus;
  expectedFiles: number;
  expectedBytes: number;
  completedFiles: number;
  failedFiles: number;
  completedBytes: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface UploadedFile {
  fileId: string;
  relativePath: string;
  blobName: string;
  sizeBytes: number;
  status: "COMPLETED" | "FAILED";
  etag: string | null;
  errorMessage: string | null;
  retryCount: number;
  updatedAt: string;
}

export type FileState = "queued" | "uploading" | "completed" | "failed";

export interface SelectedFile {
  id: string;
  file: File;
  relativePath: string;
  state: FileState;
  progress: number;
  error?: string;
  result?: UploadedFile;
}
