// DAR introspection: compiled package in, fuzzing action space out.
//
// The action space is the JSON contract between introspection and the
// generator: for every template, the fields needed to create it and the
// choices (with fully resolved argument fields) needed to exercise it. The
// generator consumes ONLY this file -- that is what "zero manual config"
// means in the M1 deliverable.
//
// A DAR is a zip of one dalf per package. `damlc inspect` only prints the
// MAIN package, but real targets (the Canton Network Token Standard) keep
// their interfaces and argument records in DEPENDENCY packages -- so
// introspection extracts every non-stdlib dalf and inspects each one. All
// cross-package references are then canonicalized to "pkgId:Module:Name",
// which is also the id format the JSON Ledger API expects.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseInspectDump,
  type FieldDef,
  type LfModel,
  type TypeDesc,
} from "./lfparse.ts";
import { readZip } from "./zip.ts";
import { winCommandLine } from "./winshell.ts";

export interface ActionSpaceField {
  name: string;
  type: TypeDesc;
}

export interface ActionSpaceChoice {
  name: string;
  consuming: boolean;
  /** Argument fields, resolved from the choice's argument record. */
  args: ActionSpaceField[] | null;
  /** Canonical ref of the argument record ("pkgId:Module:Name"). */
  argType: string;
  returns: string;
  /** Set when the choice comes from an implemented interface: the canonical
   * interface id -- the executor exercises with THIS as the templateId. */
  interfaceId?: string;
}

export interface ActionSpaceTemplate {
  module: string;
  name: string;
  /** The defining package -- templates can come from any package in the DAR.
   * Optional only for pre-multi-package action-space JSONs (the executor
   * falls back to the space-level packageId). */
  packageId?: string;
  fields: ActionSpaceField[];
  /** Template fields of type Party — the candidate actors/signatories. */
  partyFields: string[];
  choices: ActionSpaceChoice[];
}

export interface ActionSpace {
  package: string;
  /** The main package's id (templates carry their own). */
  packageId: string;
  lfVersion: string;
  templates: ActionSpaceTemplate[];
  /** Every serializable record across the DAR's inspected packages, keyed by
   * canonical ref — the generator recurses into these for nested arguments.
   * (Optional only in pre-multi-package action-space JSONs.) */
  records?: Record<string, ActionSpaceField[]>;
  /** Canonical ids of every interface seen — the executor needs to know
   * whether a ContractId argument's target is a template or an interface
   * (the ACS filter shape differs). */
  interfaces?: string[];
}

const ARCHIVE_ARG_SUFFIX = ":DA.Internal.Template:Archive";

/** Packages that carry no fuzzable templates and cost seconds each to
 * inspect. (DA.Internal.Template:Archive is referenced but Archive choices
 * are filtered by default anyway.) */
const SKIP_DALF = /^(daml-prim|daml-stdlib|daml-script)\b/;

export function runDamlcInspect(path: string, damlCmd = "daml"): string {
  const options = { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 } as const;
  // The assistant is a .cmd shim on Windows, which Node refuses to spawn
  // without a shell; pass a single pre-quoted command string there.
  const res =
    process.platform === "win32"
      ? spawnSync(winCommandLine(damlCmd, ["damlc", "inspect", path]), {
          ...options,
          shell: true,
        })
      : spawnSync(damlCmd, ["damlc", "inspect", path], options);
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`damlc inspect failed (exit ${res.status}):\n${res.stderr}`);
  }
  return res.stdout;
}

/** Inspect every relevant package in the DAR: main package FIRST (its
 * templates lead the action space), then each non-stdlib dependency. */
export function inspectDarModels(darPath: string, damlCmd = "daml"): LfModel[] {
  const entries = readZip(readFileSync(darPath));

  // MANIFEST.MF wraps values at 72 bytes; continuation lines start with a
  // single space. Unwrap before looking for Main-Dalf.
  const manifest = entries.find((e) => /META-INF\/MANIFEST\.MF$/i.test(e.name));
  const mainDalf = manifest
    ?.read()
    .toString("utf8")
    .replace(/\r?\n /g, "")
    .match(/^Main-Dalf: *(.+?)\s*$/m)?.[1];

  const dalfs = entries
    .filter((e) => {
      if (!e.name.endsWith(".dalf")) return false;
      const base = e.name.split("/").pop()!;
      return e.name === mainDalf || !SKIP_DALF.test(base);
    })
    .sort((a, b) => Number(b.name === mainDalf) - Number(a.name === mainDalf));
  if (dalfs.length === 0) throw new Error(`${darPath}: no dalf entries found`);

  const tmp = mkdtempSync(join(tmpdir(), "daml-fuzz-"));
  try {
    return dalfs.map((e) => {
      const p = join(tmp, e.name.split("/").pop()!);
      writeFileSync(p, e.read());
      return parseInspectDump(runDamlcInspect(p, damlCmd));
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ------------------------------------------------- reference resolution ----

const hasPkgPrefix = (ref: string) => /^[0-9a-f]{16,}:/.test(ref);

/** "Module:Name" printed inside package P means "P:Module:Name". */
const canonRef = (ref: string, homePkg: string): string =>
  hasPkgPrefix(ref) ? ref : `${homePkg}:${ref}`;

function canonType(t: TypeDesc, homePkg: string): TypeDesc {
  switch (t.kind) {
    case "record": return { kind: "record", ref: canonRef(t.ref, homePkg) };
    case "contractId": return { kind: "contractId", of: canonRef(t.of, homePkg) };
    case "list": return { kind: "list", of: canonType(t.of, homePkg) };
    case "optional": return { kind: "optional", of: canonType(t.of, homePkg) };
    default: return t;
  }
}

const toFields = (fields: FieldDef[], homePkg: string): ActionSpaceField[] =>
  fields.map((f) => ({ name: f.name, type: canonType(f.type, homePkg) }));

export function buildActionSpace(
  modelOrModels: LfModel | LfModel[],
  opts: { includeArchive?: boolean } = {},
): ActionSpace {
  const models = Array.isArray(modelOrModels) ? modelOrModels : [modelOrModels];
  const main = models[0];

  // Global lookup tables, canonical keys.
  const recordsByRef = new Map<string, { fields: ActionSpaceField[] }>();
  const interfacesByRef = new Map<
    string,
    { homePkg: string; model: LfModel; choices: LfModel["templates"][0]["choices"] }
  >();
  for (const m of models) {
    for (const [key, rec] of m.records) {
      if (!rec.serializable) continue;
      recordsByRef.set(`${m.packageId}:${key}`, { fields: toFields(rec.fields, m.packageId) });
    }
    for (const [key, ifc] of m.interfaces)
      interfacesByRef.set(`${m.packageId}:${key}`, {
        homePkg: m.packageId,
        model: m,
        choices: ifc.choices,
      });
  }

  const wantChoice = (argTypeCanon: string) =>
    opts.includeArchive || !argTypeCanon.endsWith(ARCHIVE_ARG_SUFFIX);

  const resolveChoice = (
    ch: { name: string; consuming: boolean; argType: string; returnType: string },
    homePkg: string,
    interfaceId?: string,
  ): ActionSpaceChoice => {
    const argType = canonRef(ch.argType, homePkg);
    const argRecord = recordsByRef.get(argType);
    return {
      name: ch.name,
      consuming: ch.consuming,
      args: argRecord ? argRecord.fields : null,
      argType,
      returns: ch.returnType,
      ...(interfaceId ? { interfaceId } : {}),
    };
  };

  const templates: ActionSpaceTemplate[] = models.flatMap((m) =>
    m.templates.map((tpl) => {
      const payload = m.records.get(`${tpl.module}:${tpl.name}`);
      const fields = payload ? toFields(payload.fields, m.packageId) : [];
      const partyFields = fields
        .filter((f) => f.type.kind === "party")
        .map((f) => f.name);

      const choices = tpl.choices
        .map((ch) => resolveChoice(ch, m.packageId))
        .filter((ch) => wantChoice(ch.argType));

      // Choices gained through implemented interfaces: exercised with the
      // INTERFACE id, argument records resolved in the interface's package.
      for (const rawRef of tpl.implements) {
        const ifaceId = canonRef(rawRef, m.packageId);
        const iface = interfacesByRef.get(ifaceId);
        if (!iface) continue; // interface package not in the DAR (or skipped)
        for (const ch of iface.choices) {
          const resolved = resolveChoice(ch, iface.homePkg, ifaceId);
          if (wantChoice(resolved.argType)) choices.push(resolved);
        }
      }

      return {
        module: tpl.module,
        name: tpl.name,
        packageId: m.packageId,
        fields,
        partyFields,
        choices,
      };
    }),
  );

  return {
    package: main.packageName,
    packageId: main.packageId,
    lfVersion: main.lfVersion,
    templates,
    records: Object.fromEntries(
      [...recordsByRef].map(([k, v]) => [k, v.fields]),
    ),
    interfaces: [...interfacesByRef.keys()],
  };
}

export function introspectDar(
  darPath: string,
  opts: { includeArchive?: boolean; damlCmd?: string } = {},
): ActionSpace {
  return buildActionSpace(inspectDarModels(darPath, opts.damlCmd ?? "daml"), opts);
}
