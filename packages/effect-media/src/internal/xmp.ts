// Removing location properties from an XMP packet without an XML parser: each
// property is found by its namespace URI, whatever prefix the packet binds it to.
import * as Option from "effect/Option";
import { decodeText, encodeText } from "./bytes.ts";

interface Target {
  readonly namespace: string;
  /** Local names, as a regular expression source. */
  readonly names: string;
}

const targets: ReadonlyArray<Target> = [
  { namespace: "http://ns.adobe.com/exif/1.0/", names: "GPS[A-Za-z]*" },
  { namespace: "http://ns.adobe.com/photoshop/1.0/", names: "City|State|Country" },
  { namespace: "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/", names: "Location|CountryCode" },
  {
    namespace: "http://iptc.org/std/Iptc4xmpExt/2008-02-29/",
    names: "LocationCreated|LocationShown",
  },
];

const NAMESPACE = /xmlns:([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
// Left behind only if the packet hides coordinates where the patterns cannot see them.
const COORDINATES = /GPS(?:Latitude|Longitude)/;

const escape = (text: string): string => text.replace(/[.\\-]/g, (c) => `\\${c}`);

const removeProperties = (xml: string, prefix: string, names: string): string => {
  const p = escape(prefix);
  return xml
    .replace(new RegExp(`\\s+${p}:(?:${names})\\s*=\\s*(?:"[^"]*"|'[^']*')`, "g"), "")
    .replace(new RegExp(`<${p}:(?:${names})\\b[^>]*/>`, "g"), "")
    .replace(new RegExp(`<${p}:(${names})\\b[^>]*>[\\s\\S]*?</${p}:\\1\\s*>`, "g"), "");
};

/**
 * The packet without its location properties: GPS coordinates, city, state
 * and country, and IPTC locations. `None` when the packet must be dropped
 * instead, because it is not readable XMP or coordinates survive the edit.
 * The same array when there was nothing to remove.
 */
export const withoutLocation = (packet: Uint8Array): Option.Option<Uint8Array> => {
  const xml = decodeText(packet);
  if (!xml.includes("<x:xmpmeta") && !xml.includes("rdf:RDF")) {
    return Option.none();
  }
  const bindings = Array.from(xml.matchAll(NAMESPACE), ([, prefix = "", d, s]) => ({
    prefix,
    namespace: d ?? s ?? "",
  }));
  const edited = targets.reduce(
    (text, { namespace, names }) =>
      bindings
        .filter((binding) => binding.namespace === namespace)
        .reduce((current, { prefix }) => removeProperties(current, prefix, names), text),
    xml,
  );
  if (COORDINATES.test(edited)) {
    return Option.none();
  }
  return Option.some(edited === xml ? packet : Uint8Array.from(encodeText(edited)));
};
