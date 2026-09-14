import "dotenv/config";

/**
 * Lists free models that support tool calling, read live from OpenRouter.
 * Free-tier availability changes often, so this is the source of truth rather
 * than any model name written into the repo.
 */

const KEY = process.env.OPENROUTER_API_KEY;

interface ModelEntry {
  id: string;
  name: string;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string };
}

async function main() {
  const res = await fetch(
    "https://openrouter.ai/api/v1/models?supported_parameters=tools",
    { headers: KEY ? { Authorization: `Bearer ${KEY}` } : {} }
  );

  if (!res.ok) {
    console.error(`Model list failed: ${res.status}`);
    process.exit(1);
  }

  const models: ModelEntry[] = (await res.json()).data ?? [];

  const free = models.filter(
    (m) =>
      m.supported_parameters?.includes("tools") &&
      Number(m.pricing?.prompt ?? "1") === 0 &&
      Number(m.pricing?.completion ?? "1") === 0
  );

  console.log(`${free.length} free models support tool calling:\n`);

  for (const m of free) {
    const ctx = m.context_length
      ? `${Math.round(m.context_length / 1000)}k`.padStart(7)
      : "      ?";
    console.log(`  ${m.id.padEnd(48)} ${ctx}   ${m.name}`);
  }

  console.log(
    "\nPrefer the largest model on this list. This agent chains several\n" +
      "arithmetic steps, which is where small models drop reasoning.\n"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});