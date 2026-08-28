import { ImagePlus, Upload, X } from "lucide-react";
import { useRef, useState } from "react";

interface ImageUploaderProps {
  /** `file` is the real upload sent to the backend; `imageUrl` is the local preview blob URL, kept for display. */
  onAnalyze: (file: File, imageUrl: string) => void;
  isAnalyzing?: boolean;
}

function ImageUploader({ onAnalyze, isAnalyzing = false }: ImageUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const handleFileChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      alert("Please select an image file.");
      return;
    }

    const url = URL.createObjectURL(file);

    setImageUrl(url);
    setFileName(file.name);
    setSelectedFile(file);
  };

  const handleRemove = () => {
    if (imageUrl) {
      URL.revokeObjectURL(imageUrl);
    }

    setImageUrl(null);
    setFileName("");
    setSelectedFile(null);

    if (inputRef.current) {
      inputRef.current.value = "";
    }
  };

  const handleAnalyze = () => {
    if (!imageUrl || !selectedFile) {
      return;
    }

    onAnalyze(selectedFile, imageUrl);
  };

  return (
    <section className="upload-panel">
      {!imageUrl ? (
        <>
          <div className="upload-icon">
            <ImagePlus size={32} />
          </div>

          <h4>Upload your PCB image</h4>

          <p>
            Choose a clear image of the PCB so CircuitLoop can
            identify potentially reusable components.
          </p>

          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg"
            onChange={handleFileChange}
            hidden
          />

          <button
            className="upload-button"
            onClick={() => inputRef.current?.click()}
          >
            <Upload size={18} />
            Choose Image
          </button>

          <span className="upload-hint">
            PNG, JPG or JPEG • Recommended: clear, high-resolution image
          </span>
        </>
      ) : (
        <div className="image-preview-container">
          <div className="preview-header">
            <div>
              <span className="eyebrow">SELECTED IMAGE</span>
              <h4>{fileName}</h4>
            </div>

            <button
              className="remove-image-button"
              onClick={handleRemove}
              aria-label="Remove image"
            >
              <X size={18} />
            </button>
          </div>

          <div className="image-preview">
            <img
              src={imageUrl}
              alt="Selected PCB"
            />
          </div>

          <button
            className="upload-button analyze-button"
            onClick={handleAnalyze}
            disabled={isAnalyzing}
          >
            <ImagePlus size={18} />
            {isAnalyzing ? "Analyzing..." : "Analyze PCB"}
          </button>
        </div>
      )}
    </section>
  );
}

export default ImageUploader;