import type { PCBScan } from "../types/component";

export const mockScan: PCBScan = {
  id: "PCB-001",
  imageUrl: "/pcb-placeholder.svg",
  createdAt: "2026-08-20T14:30:00",
  components: [
    {
      id: "U5",
      type: "microcontroller",
      value: "Unknown MCU",
      confidence: 0.95,
      condition: "good",
      salvagePriority: "high",
      boundingBox: {
        x: 55,
        y: 30,
        width: 15,
        height: 12,
      },
      test: {
        status: "NOT_SUPPORTED",
      },
    },
    {
      id: "R12",
      type: "resistor",
      value: "10kΩ",
      confidence: 0.97,
      condition: "good",
      salvagePriority: "medium",
      boundingBox: {
        x: 35,
        y: 52,
        width: 8,
        height: 4,
      },
      test: {
        status: "PASS",
        expected: 10000,
        measured: 9980,
        unit: "Ω",
      },
    },
    {
      id: "D3",
      type: "led",
      value: "Red LED",
      confidence: 0.92,
      condition: "good",
      salvagePriority: "medium",
      boundingBox: {
        x: 72,
        y: 65,
        width: 7,
        height: 7,
      },
      test: {
        status: "PASS",
        expected: 2,
        measured: 1.98,
        unit: "V",
      },
    },
    {
      id: "C4",
      type: "capacitor",
      value: "100µF",
      confidence: 0.89,
      condition: "uncertain",
      salvagePriority: "low",
      boundingBox: {
        x: 25,
        y: 25,
        width: 8,
        height: 10,
      },
      test: {
        status: "NOT_TESTED",
      },
    },
  ],
};