/**
 * Ejecuta wrangler (la herramienta de Cloudflare) con la sesión de la cuenta de negocios.
 *
 * Este computador ya tiene iniciada otra cuenta de Cloudflare (la personal). Para no mezclarlas,
 * la sesión de este proyecto se guarda aparte, en la carpeta .cloudflare-negocios del usuario,
 * y todo lo de este proyecto se hace con:
 *
 *   node cf.mjs login      node cf.mjs whoami      node cf.mjs deploy      …
 *
 * Además, wrangler.toml lleva el account_id de la cuenta de negocios: si por error se usa
 * wrangler directo con la cuenta personal, falla en vez de publicar donde no es.
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const result = spawnSync(
  process.execPath,
  [path.join(here, 'node_modules/wrangler/bin/wrangler.js'), ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: here, env: { ...process.env, XDG_CONFIG_HOME: path.join(os.homedir(), '.cloudflare-negocios') } },
);
process.exit(result.status ?? 1);
