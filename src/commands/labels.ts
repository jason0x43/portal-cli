import type { Config } from "../config.ts";
import { baseDigestLabels } from "../outdated.ts";
import { warn } from "../ui.ts";

/**
 * Print the labels portal adds when it builds a service's image, one
 * key=value per line, for builds done elsewhere such as in CI. A label that
 * can't be worked out is left out with a warning, so the build still runs.
 */
export async function labels(config: Config) {
  const { labels, problem } = await baseDigestLabels(config);
  if (problem) {
    warn(problem);
  }
  for (const [key, value] of Object.entries(labels)) {
    console.log(`${key}=${value}`);
  }
}
