// Parser for the pretty-printed Daml-LF that `daml damlc inspect <dar>` emits.
//
// This is the introspection front-end of the M1 tool: from a compiled package
// it recovers modules, serializable records (template payloads and choice
// arguments), templates, and choices -- everything the generator needs to form
// an action space with zero manual configuration.
//
// The text format (SDK 3.4.x, LF 2.x) is line-oriented and stable enough for a
// first implementation:
//
//   package <hex id>
//   daml-lf 2.2
//   metadata <name>-<version>
//   module <Name> where
//   record @serializable <Name> = {<field> : <Type>; ...}      (may span lines)
//   variant @serializable <Name> = ...
//   template <Name> this where
//       consuming choice <Name> (self : ContractId <Mod>:<Tpl>) (arg : <ArgType>) : <RetType>
//           controller ...
//       interface instance <pkgId>:<Mod>:<Iface> for <Mod>:<Tpl>
//   interface <Name> this where
//       viewtype <ref>
//       method <name> : <type>
//       non-consuming choice <Name> (self : ...) (arg : <ArgType>) : <RetType>
//
// Note the asymmetry the dumps actually have: template choices print
// "nonconsuming", interface choices print "non-consuming".
//
// The long-term replacement is decoding the daml_lf protobuf directly; the
// model types below are the contract that swap must preserve.

export type TypeDesc =
  | { kind: "party" }
  | { kind: "text" }
  | { kind: "int" }
  | { kind: "bool" }
  | { kind: "numeric"; scale: number }
  | { kind: "timestamp" }
  | { kind: "date" }
  | { kind: "unit" }
  | { kind: "contractId"; of: string }
  | { kind: "list"; of: TypeDesc }
  | { kind: "optional"; of: TypeDesc }
  | { kind: "genmap" }
  | { kind: "textmap" }
  | { kind: "record"; ref: string }
  | { kind: "unsupported"; raw: string };

export interface FieldDef {
  name: string;
  rawType: string;
  type: TypeDesc;
}

export interface RecordDef {
  module: string;
  name: string;
  serializable: boolean;
  fields: FieldDef[];
}

export interface ChoiceDef {
  name: string;
  consuming: boolean;
  /** Raw LF reference of the argument record, e.g. "Dsl:TransferA". */
  argType: string;
  returnType: string;
}

export interface TemplateDef {
  module: string;
  name: string;
  choices: ChoiceDef[];
  /** Raw refs of implemented interfaces, as printed — usually
   * "pkgId:Module:Iface" (interfaces live in other packages). */
  implements: string[];
}

export interface InterfaceDef {
  module: string;
  name: string;
  choices: ChoiceDef[];
}

export interface LfModel {
  packageId: string;
  lfVersion: string;
  packageName: string;
  /** Keyed by "Module:Name". */
  records: Map<string, RecordDef>;
  templates: TemplateDef[];
  /** Keyed by "Module:Name". */
  interfaces: Map<string, InterfaceDef>;
}

const stripOuterParens = (s: string): string => {
  let t = s.trim();
  while (t.startsWith("(") && t.endsWith(")")) t = t.slice(1, -1).trim();
  return t;
};

export function parseType(raw: string): TypeDesc {
  const t = stripOuterParens(raw);
  switch (t) {
    case "Party": return { kind: "party" };
    case "Text": return { kind: "text" };
    case "Int64": return { kind: "int" };
    case "Bool": return { kind: "bool" };
    case "Timestamp": return { kind: "timestamp" };
    case "Date": return { kind: "date" };
    case "Unit": return { kind: "unit" };
  }
  const numeric = t.match(/^Numeric (\d+)$/);
  if (numeric) return { kind: "numeric", scale: Number(numeric[1]) };
  // Key/value types are irrelevant: the generator only ever emits the empty
  // map (which is also what keeps variant-valued maps like Splice's
  // `TextMap AnyValue` out of the unsupported bucket). The kinds stay
  // distinct because Daml-JSON encodes them differently ({} vs []).
  if (/^GenMap /.test(t)) return { kind: "genmap" };
  if (/^TextMap /.test(t)) return { kind: "textmap" };
  const cid = t.match(/^ContractId (.+)$/);
  if (cid) return { kind: "contractId", of: stripOuterParens(cid[1]) };
  const list = t.match(/^List (.+)$/);
  if (list) return { kind: "list", of: parseType(list[1]) };
  const opt = t.match(/^Option (.+)$/);
  if (opt) return { kind: "optional", of: parseType(opt[1]) };
  // Qualified reference: [pkgHash:]Module.Path:Name — a record/variant ref.
  if (/^(?:[0-9a-f]{16,}:)?[\w.$]+:[\w$]+$/.test(t)) return { kind: "record", ref: t };
  return { kind: "unsupported", raw: t };
}

const parseFields = (body: string): FieldDef[] =>
  body
    .split(";")
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .flatMap((f) => {
      const m = f.match(/^([\w$]+)\s*:\s*([\s\S]+)$/);
      if (!m) return [];
      const rawType = m[2].replace(/\s+/g, " ").trim();
      return [{ name: m[1], rawType, type: parseType(rawType) }];
    });

const CHOICE_RE =
  /^\s+(consuming|nonconsuming|non-consuming)\s+choice\s+([\w$]+)\s+\(self : ContractId [^)]+\)\s+\(arg : ([^)]+)\)\s+:\s+(.+?)\s*$/;

const INSTANCE_RE = /^\s+interface instance (\S+) for \S+\s*$/;

export function parseInspectDump(text: string): LfModel {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const model: LfModel = {
    packageId: "",
    lfVersion: "",
    packageName: "",
    records: new Map(),
    templates: [],
    interfaces: new Map(),
  };
  let currentModule = "";
  let currentTemplate: TemplateDef | null = null;
  let currentInterface: InterfaceDef | null = null;
  const endBlock = () => { currentTemplate = null; currentInterface = null; };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const pkg = line.match(/^package ([0-9a-f]+)\s*$/);
    if (pkg) { model.packageId = pkg[1]; continue; }
    const lf = line.match(/^daml-lf (\S+)/);
    if (lf) { model.lfVersion = lf[1]; continue; }
    const meta = line.match(/^metadata (\S+)/);
    if (meta) { model.packageName = meta[1]; continue; }

    const mod = line.match(/^module ([\w.$]+) where\s*$/);
    if (mod) { currentModule = mod[1]; endBlock(); continue; }

    const rec = line.match(/^record( @serializable)?\s+([\w$]+)\s*(?:\([^)]*\)\s*)*=(.*)$/);
    if (rec) {
      endBlock();
      // Accumulate lines until the {...} braces balance.
      let acc = rec[3];
      while (!braced(acc) && i + 1 < lines.length) acc += " " + lines[++i];
      const open = acc.indexOf("{");
      const close = acc.lastIndexOf("}");
      const body = open >= 0 && close > open ? acc.slice(open + 1, close) : "";
      const def: RecordDef = {
        module: currentModule,
        name: rec[2],
        serializable: rec[1] !== undefined,
        fields: parseFields(body),
      };
      model.records.set(`${currentModule}:${def.name}`, def);
      continue;
    }

    const tpl = line.match(/^template ([\w$]+) this where\s*$/);
    if (tpl) {
      endBlock();
      currentTemplate = { module: currentModule, name: tpl[1], choices: [], implements: [] };
      model.templates.push(currentTemplate);
      continue;
    }

    const ifc = line.match(/^interface ([\w$]+) this where\s*$/);
    if (ifc) {
      endBlock();
      currentInterface = { module: currentModule, name: ifc[1], choices: [] };
      model.interfaces.set(`${currentModule}:${currentInterface.name}`, currentInterface);
      continue;
    }

    const block = currentTemplate ?? currentInterface;
    if (block) {
      const ch = line.match(CHOICE_RE);
      if (ch) {
        block.choices.push({
          name: ch[2],
          consuming: ch[1] === "consuming",
          argType: ch[3].trim(),
          returnType: ch[4].trim(),
        });
        continue;
      }
      if (currentTemplate) {
        const inst = line.match(INSTANCE_RE);
        if (inst) { currentTemplate.implements.push(inst[1]); continue; }
      }
      // Any other column-0 declaration ends the template/interface block.
      if (/^\S/.test(line)) endBlock();
    }
  }
  return model;
}

const braced = (s: string): boolean => {
  const opens = (s.match(/\{/g) ?? []).length;
  const closes = (s.match(/\}/g) ?? []).length;
  return opens > 0 && opens === closes;
};
