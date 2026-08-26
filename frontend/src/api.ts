const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000";

export interface DashboardStats {
  total_scans: number;
  total_components: number;
  tested_components: number;
  passed_components: number;
  failed_components: number;
  not_tested_components: number;
  average_ai_confidence: number | null;
}

export interface ApiComponent {
  id: number;
  scan_id: number | null;
  type: string;
  name: string | null;
  confidence: number;
  status: string;
  created_at: string;
}

export interface AssistantResponse {
  component_id: number;
  configured: boolean;
  message: string;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function getDashboardStats() {
  return request<DashboardStats>("/api/dashboard/stats");
}

export function getComponents() {
  return request<ApiComponent[]>("/api/components");
}

export function askAssistant(componentId: number, question: string) {
  return request<AssistantResponse>("/api/assistant", {
    method: "POST",
    body: JSON.stringify({ component_id: componentId, question }),
  });
}