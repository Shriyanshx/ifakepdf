"use client";

import { useDropzone } from "react-dropzone";
import { FileText, UploadCloud } from "lucide-react";

interface FileDropzoneProps {
  onFile: (file: File) => void;
}

export default function FileDropzone({ onFile }: FileDropzoneProps) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { "application/pdf": [".pdf"] },
    multiple: false,
    onDrop: (accepted) => {
      if (accepted[0]) onFile(accepted[0]);
    },
  });

  return (
    <div
      {...getRootProps()}
      className={`dropzone ${isDragActive ? "active" : ""}`}
    >
      <input {...getInputProps()} />
      <div className="w-14 h-14 rounded-2xl bg-indigo-600/10 border border-indigo-500/30 flex items-center justify-center">
        {isDragActive ? (
          <UploadCloud size={28} className="text-indigo-400" />
        ) : (
          <FileText size={28} className="text-indigo-400" />
        )}
      </div>
      <div>
        <p className="text-sm font-semibold text-slate-200">
          {isDragActive ? "Drop your PDF here" : "Upload a PDF"}
        </p>
        <p className="text-xs text-slate-500 mt-1">
          Drag &amp; drop or click to browse
        </p>
      </div>
      <p className="text-[11px] text-slate-600 border border-[#2e3348] rounded-full px-3 py-1">
        PDF files only
      </p>
    </div>
  );
}
