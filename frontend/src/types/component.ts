export type ComponentType =
  | "resistor"
  | "capacitor"
  | "led"
  | "diode"
  | "transistor"
  | "ic"
  | "microcontroller"
  | "unknown";

export type ComponentCondition =
  | "good"
  | "damaged"
  | "uncertain"
  | "unknown";

export type SalvagePriority =
  | "high"
  | "medium"
  | "low";

export type TestStatus =
  | "PASS"
  | "FAIL"
  | "NOT_TESTED"
  | "NOT_SUPPORTED";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElectricalTest {
  status: TestStatus;
  expected?: number;
  measured?: number;
  unit?: string;
}

export interface PCBComponent {
  id: string;
  type: ComponentType;
  value?: string;
  confidence: number;
  condition: ComponentCondition;
  salvagePriority: SalvagePriority;
  boundingBox: BoundingBox;
  test: ElectricalTest;
}

export interface PCBScan {
  id: string;
  imageUrl: string;
  components: PCBComponent[];
  createdAt: string;
}