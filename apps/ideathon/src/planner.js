import { GoogleAuth } from "google-auth-library";
import { ALLOWED_TOOLS } from "./policy.js";

const JSON_BLOCK = /\{[\s\S]*\}/;

export function parsePlan(text) {
  const match = String(text).match(JSON_BLOCK);
  if (!match) throw new Error("Gemini did not return a JSON action");
  const value = JSON.parse(match[0]);
  if (!ALLOWED_TOOLS.includes(value.tool)) throw new Error("Gemini proposed an unsupported tool");
  if (!value.args || typeof value.args !== "object" || Array.isArray(value.args)) {
    throw new Error("Gemini returned invalid tool arguments");
  }
  return { tool: value.tool, args: value.args, explanation: String(value.explanation || "") };
}

export async function planAction(intent, config) {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error("Unable to obtain a Google Cloud access token");

  const endpoint = `https://${config.location}-aiplatform.googleapis.com/v1/projects/${config.projectId}/locations/${config.location}/publishers/google/models/${config.model}:generateContent`;
  const prompt = `You are an AI agent action planner. Convert the user's intent into exactly one tool call.
Available tools:
- customer.read {customer_id: string}
- customer.delete {customer_id: string}
- payment.refund {payment_id: string, amount: number}
- support.ticket.create {subject: string, priority: "low"|"normal"|"high"}
- shell.exec {cmd: string}

Return JSON only: {"tool":"...","args":{},"explanation":"one short sentence"}.
Never invent a different tool. User intent: ${JSON.stringify(intent)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 256, responseMimeType: "application/json" },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Vertex AI request failed (${response.status})`);
  const body = await response.json();
  const text = body?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
  return parsePlan(text);
}
