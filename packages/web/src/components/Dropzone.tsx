import { useRef, useState } from "react";
import { api } from "../api";
import { cn } from "../lib/ui";

export function Dropzone({ onUploaded }: { onUploaded: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragover, setDragover] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setError(null);
    setUploadPct(0);
    try {
      await api.uploadVideo(file, setUploadPct);
      onUploaded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "upload failed");
    } finally {
      setUploadPct(null);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Choose a video to upload, or drop one here"
      className={cn(
        "cursor-pointer rounded-[10px] border-[1.5px] border-dashed bg-subtle px-4 py-10 text-center text-muted transition-colors hover:border-brand focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
        dragover ? "border-brand bg-brand-soft text-ink" : "border-line-strong",
      )}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        // Without this the dropzone is mouse-only: it is the sole way to pick
        // a file, so keyboard users could not upload at all.
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragover(true);
      }}
      onDragLeave={() => setDragover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragover(false);
        const file = e.dataTransfer.files[0];
        if (file) upload(file);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
      />
      {uploadPct === null ? (
        <div className="flex flex-col items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-8 h-8 text-muted">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
          </svg>
          <p className="text-[0.95rem]">Drag &amp; drop a video here, or click to choose a file.</p>
        </div>
      ) : (
        <div className="mx-auto max-w-[360px]">
          <p className="mb-2 text-sm">Uploading… {uploadPct}%</p>
          <div className="h-2 overflow-hidden rounded-full bg-sunken">
            <span className="block h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${uploadPct}%` }} />
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-err">{error}</p>}
    </div>
  );
}
