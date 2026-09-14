import fs from "node:fs";
import path from "node:path";
import type { ChatResponse } from "@/lib/openrouter";

/**
 * Records and replays LLM responses.
 *
 * Only the model is stubbed. Tools still hit the real database, validation still
 * recomputes from live state, and the feedback loop still runs. What replay
 * removes is the network call and its cost, rate limit and nondeterminism.
 *
 * This exists for three reasons:
 *   1. UI development would otherwise burn a free-tier daily quota on re-renders
 *   2. CI can run the full agent suite with no API key
 *   3. The deployed demo keeps working when the model is rate-limited or retired
 *
 * Fixtures live at the repo root rather than under src/ so they are plain data
 * files, readable by the CLI, tests and the server without bundler involvement.
 */

const FIXTURE_DIR = path.join(process.cwd(), "fixtures");

export interface Fixture {
  scenarioKey: string;
  model: string;
  recordedAt: string;
  responses: ChatResponse[];
}

function fixturePath(scenarioKey: string): string {
  return path.join(FIXTURE_DIR, `${scenarioKey}.json`);
}

export function hasFixture(scenarioKey: string): boolean {
  return fs.existsSync(fixturePath(scenarioKey));
}

export function listFixtures(): string[] {
  if (!fs.existsSync(FIXTURE_DIR)) return [];
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function loadFixture(scenarioKey: string): Fixture {
  const file = fixturePath(scenarioKey);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No fixture for scenario "${scenarioKey}". Record one first: npm run agent ${scenarioKey} -- --record`
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as Fixture;
}

/** Truncates any existing fixture so a re-record never merges with an old run. */
export function startRecording(scenarioKey: string, model: string): void {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const fixture: Fixture = {
    scenarioKey,
    model,
    recordedAt: new Date().toISOString(),
    responses: [],
  };
  fs.writeFileSync(fixturePath(scenarioKey), JSON.stringify(fixture, null, 2));
}

/**
 * Appends one response. Written on every step rather than buffered, so a run
 * that dies partway still leaves a usable partial trace to inspect.
 */
export function recordResponse(
  scenarioKey: string,
  stepIndex: number,
  response: ChatResponse
): void {
  const file = fixturePath(scenarioKey);
  if (!fs.existsSync(file)) {
    startRecording(scenarioKey, response.model);
  }
  const fixture = loadFixture(scenarioKey);
  fixture.responses[stepIndex] = response;
  fs.writeFileSync(file, JSON.stringify(fixture, null, 2));
}

export function replayResponse(
  scenarioKey: string,
  stepIndex: number
): ChatResponse {
  const fixture = loadFixture(scenarioKey);
  const response = fixture.responses[stepIndex];

  if (!response) {
    throw new Error(
      `Fixture for "${scenarioKey}" has ${fixture.responses.length} recorded step(s); ` +
        `step ${stepIndex} was requested. The recorded run and the current run have diverged — re-record it.`
    );
  }

  return response;
}