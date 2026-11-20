/**
 * EXAMPLE ONLY: see README.md in this folder before using any of it.
 *
 * Reads what `extract.ts` writes: `shop.json` (shop settings, locations and
 * locales, read with plain queries) and one JSONL file per bulk operation.
 *
 * A bulk operation flattens nested connections. Every object of a connection
 * is a line of its own, and a nested one names the object it belongs to in
 * `__parentId`. So a product's variants, collections, metafields and media are
 * separate lines after the product line, and a variant's media and inventory
 * levels name the variant they belong to. This module puts them back together by that id and
 * by the type in each object's global id (`gid://shopify/<Type>/<n>`); it
 * maps nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Obj = Record<string, unknown>;

export interface ShopFile {
  apiVersion?: string;
  extractedAt?: string;
  shop: {
    name?: string;
    currencyCode: string;
    taxesIncluded?: boolean;
    ianaTimezone?: string;
  };
  locations?: { id: string; name: string; isActive?: boolean }[];
  shopLocales?: { locale: string; primary: boolean; published: boolean }[];
}

export interface ShopifyExport {
  shop: ShopFile;
  /** Product lines, in file order. */
  products: Obj[];
  /** Product id → the lines whose `__parentId` is that product, in file order. */
  childrenOf: Map<string, Obj[]>;
  /** Collection id → its line from `collections.jsonl` (rules, description). */
  collections: Map<string, Obj>;
  /** Variant id → its line from `variants.jsonl`, its own media and its inventory levels. */
  variants: Map<string, { variant: Obj; media: Obj[]; levels: Obj[] }>;
}

export const EXPORT_FILES = ['shop.json', 'products.jsonl', 'collections.jsonl', 'variants.jsonl'] as const;

/** The type part of a global id: `gid://shopify/ProductVariant/1` → `ProductVariant`. */
export function gidType(id: unknown): string | undefined {
  if (typeof id !== 'string') return undefined;
  return /^gid:\/\/shopify\/([A-Za-z0-9]+)\//.exec(id)?.[1];
}

export function readJsonl(path: string): Obj[] {
  const text = readFileSync(path, 'utf8');
  const out: Obj[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      out.push(JSON.parse(line) as Obj);
    } catch {
      throw new Error(`${path}:${i + 1} is not valid JSON.`);
    }
  });
  return out;
}

export function readExport(dir: string): ShopifyExport {
  const missing = EXPORT_FILES.filter((f) => !existsSync(join(dir, f)));
  if (missing.length > 0) {
    throw new Error(`${dir} lacks ${missing.join(', ')}. Run the extractor (extract.ts) into this directory first.`);
  }
  const shop = JSON.parse(readFileSync(join(dir, 'shop.json'), 'utf8')) as ShopFile;

  const products: Obj[] = [];
  const childrenOf = new Map<string, Obj[]>();
  for (const line of readJsonl(join(dir, 'products.jsonl'))) {
    const parent = line.__parentId;
    if (typeof parent === 'string') {
      const list = childrenOf.get(parent) ?? [];
      list.push(line);
      childrenOf.set(parent, list);
    } else if (gidType(line.id) === 'Product') {
      products.push(line);
    }
  }

  const collections = new Map<string, Obj>();
  for (const line of readJsonl(join(dir, 'collections.jsonl'))) {
    if (gidType(line.id) === 'Collection' && line.__parentId === undefined) collections.set(String(line.id), line);
  }

  const variants = new Map<string, { variant: Obj; media: Obj[]; levels: Obj[] }>();
  const nested: Obj[] = [];
  for (const line of readJsonl(join(dir, 'variants.jsonl'))) {
    if (typeof line.__parentId === 'string') nested.push(line);
    else if (gidType(line.id) === 'ProductVariant') variants.set(String(line.id), { variant: line, media: [], levels: [] });
  }
  for (const line of nested) {
    const entry = variants.get(String(line.__parentId));
    if (!entry) throw new Error(`variants.jsonl: a line names ${String(line.__parentId)}, which has no variant line.`);
    // Inventory levels carry no id of their own; media do.
    if (line.location !== undefined) entry.levels.push(line);
    else entry.media.push(line);
  }

  return { shop, products, childrenOf, collections, variants };
}
