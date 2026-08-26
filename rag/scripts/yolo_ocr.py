import argparse
import json
import os
from pathlib import Path

import cv2
import pytesseract
from ultralytics import YOLO


PROJECT_ROOT = Path(__file__).resolve().parent.parent

if tesseract_command := os.getenv("TESSERACT_CMD"):
    pytesseract.pytesseract.tesseract_cmd = tesseract_command
elif os.name == "nt":
    default_tesseract = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")
    if default_tesseract.exists():
        pytesseract.pytesseract.tesseract_cmd = str(default_tesseract)


def preprocess_crop(crop):
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    return cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]


def extract_detected_text(model_path: Path, image_path: Path, confidence: float):
    model = YOLO(str(model_path))
    image = cv2.imread(str(image_path))

    if image is None:
        raise SystemExit(f"Could not read image: {image_path}")

    result = model.predict(source=image, conf=confidence, verbose=False)[0]
    detections = []

    for box in result.boxes:
        x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
        x1 = max(0, min(x1, image.shape[1]))
        y1 = max(0, min(y1, image.shape[0]))
        x2 = max(x1, min(x2, image.shape[1]))
        y2 = max(y1, min(y2, image.shape[0]))

        crop = image[y1:y2, x1:x2]
        text = "" if crop.size == 0 else pytesseract.image_to_string(
            preprocess_crop(crop),
            config="--psm 6",
        ).strip()

        class_id = int(box.cls[0])
        detections.append({
            "class_id": class_id,
            "class_name": result.names[class_id],
            "confidence": float(box.conf[0]),
            "box": [x1, y1, x2, y2],
            "text": text,
        })

    return detections


def main():
    parser = argparse.ArgumentParser(description="Run YOLO detection followed by OCR on each detected region")
    parser.add_argument("--model", required=True, type=Path, help="YOLO .pt model path")
    parser.add_argument("--image", required=True, type=Path, help="Input image path")
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / "data" / "yolo_ocr.json")
    parser.add_argument("--confidence", type=float, default=0.25)
    args = parser.parse_args()

    if not args.model.exists():
        raise SystemExit(f"YOLO model not found: {args.model}")
    if not args.image.exists():
        raise SystemExit(f"Image not found: {args.image}")

    try:
        detections = extract_detected_text(args.model, args.image, args.confidence)
    except pytesseract.TesseractNotFoundError as error:
        raise SystemExit(
            "Tesseract OCR is not installed. Install it from https://github.com/UB-Mannheim/tesseract/wiki"
        ) from error

    output = args.output if args.output.is_absolute() else PROJECT_ROOT / args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(detections, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Saved {len(detections)} YOLO detections with OCR text to {output}")


if __name__ == "__main__":
    main()