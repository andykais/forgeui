import type { Manifest, ManifestSection, Param } from "../types.ts";

/**
 * Where each param of a panel goes (§4.2, §11.2): the main list, one of the
 * manifest's sections, or Advanced. Sections come in the order the manifest
 * lists them, each param in manifest order, and one with nothing to show —
 * every param in it switched off by a `when` — is left out rather than shown
 * as an empty heading.
 */
export interface ParamGroups {
  main: Param[];
  sections: { section: ManifestSection; params: Param[] }[];
  advanced: Param[];
}

export function groupParams(manifest: Manifest, params: Param[]): ParamGroups {
  const sections = manifest.sections ?? [];
  const known = new Set(sections.map((section) => section.id));
  // A section the manifest does not list is not one: the param stays where
  // it would have been without it, rather than vanishing.
  const inSection = (param: Param) =>
    param.section !== undefined && known.has(param.section);
  return {
    main: params.filter((param) => !inSection(param) && !param.advanced),
    sections: sections
      .map((section) => ({
        section,
        params: params.filter((param) => param.section === section.id),
      }))
      .filter((group) => group.params.length > 0),
    advanced: params.filter((param) => !inSection(param) && param.advanced),
  };
}
