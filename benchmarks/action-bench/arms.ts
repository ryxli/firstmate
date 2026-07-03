// Harness arms: the ONLY thing varied between runs. A harness arm is a
// system-prompt scaffold injected around the constant model+tools. `control` =
// no scaffold (the floor). Others are the harness under test.
import { existsSync, readFileSync } from "node:fs";

// Arm name -> scaffold text ("" = the empty control floor).
export type Arms = Record<string, string>;

export function loadArms(path: string | undefined): Arms {
	const arms: Arms = { control: "" };
	if (path && existsSync(path)) {
		arms.harness = readFileSync(path, "utf8").trim();
	}
	return arms;
}
