import "dotenv/config";

/**
 * Verifies the OpenRouter key works and lists models that actually support tool
 * calling, read live from the API rather than assumed.
 *
 * Run this before the agent loop. A dead key, an empty balance, or a retired
 * model ID all produce confusing mid-loop failures otherwise.
 */

const KEY = process.env.OPENROUTER_API_KEY;
const BASE = "https://openrouter.ai/api/v1";

interface ModelEntry {
  id: string;
  name: string;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string };
}

async function main() {
  if (!KEY) {
    console.error("OPENROUTER_API_KEY is not set in .env");
    process.exit(1);
  }

  console.log("Checking key...\n");

  const keyRes = await fetch(`${BASE}/key`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });

  if (!keyRes.ok) {
    console.error(`Key check failed: ${keyRes.status} ${keyRes.statusText}`);
    console.error(await keyRes.text());
    process.exit(1);
  }

  const keyData = await keyRes.json();
  console.log("Key is valid.");
  console.log(JSON.stringify(keyData.data ?? keyData, null, 2));

  console.log("\nFetching models that support tool calling...\n");

  const modelsRes = await fetch(`${BASE}/models?supported_parameters=tools`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });

  if (!modelsRes.ok) {
    console.error(`Model list failed: ${modelsRes.status}`);
    process.exit(1);
  }

  const models: ModelEntry[] = (await modelsRes.json()).data ?? [];

  const withTools = models.filter((m) =>
    m.supported_parameters?.includes("tools")
  );

  const promptCost = (m: ModelEntry) => Number(m.pricing?.prompt ?? "0");

  const paid = withTools
    .filter((m) => promptCost(m) > 0)
    .sort((a, b) => promptCost(a) - promptCost(b));

  const free = withTools.filter((m) => promptCost(m) === 0);

  console.log(`${withTools.length} models support tools (${free.length} free).\n`);
  console.log("Cheapest 25 paid models with tool support:\n");

  for (const m of paid.slice(0, 25)) {
    const perM = (promptCost(m) * 1_000_000).toFixed(3);
    const ctx = m.context_length ? `${Math.round(m.context_length / 1000)}k` : "?";
    console.log(`  ${m.id.padEnd(52)} $${perM.padStart(8)}/M in   ${ctx}`);
  }

  console.log(
    "\nPick one and set OPENROUTER_MODEL in .env. Prefer a paid model:\n" +
      "free tiers rate-limit aggressively and often drop tool support.\n"
  );

  const current = process.env.OPENROUTER_MODEL;
  if (current) {
    const match = withTools.find((m) => m.id === current);
    console.log(
      match
        ? `Current OPENROUTER_MODEL "${current}" is valid and supports tools.`
        : `WARNING: current OPENROUTER_MODEL "${current}" is not in the tool-calling list.`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});