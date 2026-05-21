import { useLocalStorage } from "usehooks-ts";
export function useAPIKeys() {
  return useLocalStorage("api_keys", [""]);
}
export function useAPIHost() {
  return useLocalStorage("api_host", "https://api.openai.com/v1");
}
export function useAPIProvider() {
  return useLocalStorage<"openrouter" | "openai" | "vercel-gateway" | "openai-compatible">(
    "api_provider",
    "openrouter"
  );
}
export function useTemperature() {
  return useLocalStorage("ai_temperature", 1);
}
