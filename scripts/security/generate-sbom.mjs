#!/usr/bin/env node
/**
 * Gera evidência de supply chain sem depender de ferramenta externa.
 *
 * Fontes:
 *   - package-lock.json da raiz/frontends;
 *   - obj/project.assets.json dos projetos .NET após `dotnet restore`;
 *   - .nuspec do cache NuGet resolvido, quando disponível, para metadados de licença.
 *
 * Saídas:
 *   artifacts/security/sbom.cdx.json
 *   artifacts/security/dependency-inventory.json
 *
 * O SBOM usa CycloneDX 1.5 e lista componentes resolvidos. Licenças são
 * inventário técnico declarado pelo pacote, não parecer jurídico.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputDir = join(root, 'artifacts', 'security');
mkdirSync(outputDir, { recursive: true });

const components = new Map();
const sources = [];

const normalizeLicense = (license) => {
  if (!license) return [];
  if (typeof license === 'string') return [{ license: { name: license } }];
  if (Array.isArray(license)) return license.flatMap(normalizeLicense);
  if (typeof license === 'object' && license.type) return [{ license: { name: String(license.type) } }];
  return [];
};

function integrityHash(integrity) {
  if (typeof integrity !== 'string') return null;
  const match = integrity.match(/^sha512-([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  return { alg: 'SHA-512', content: Buffer.from(match[1], 'base64').toString('hex') };
}

function decodeXml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .trim();
}

function readNugetLicense(packageRoot, name, version) {
  if (!packageRoot) return [];
  const dir = join(packageRoot, name.toLowerCase(), version.toLowerCase());
  if (!existsSync(dir)) return [];
  const nuspec = readdirSync(dir).find((file) => file.toLowerCase().endsWith('.nuspec'));
  if (!nuspec) return [];
  const xml = readFileSync(join(dir, nuspec), 'utf8');

  const license = xml.match(/<license\b([^>]*)>([\s\S]*?)<\/license>/i);
  if (license) {
    const attrs = license[1] ?? '';
    const value = decodeXml(license[2]);
    const type = attrs.match(/type\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (value) {
      if (type === 'expression') return [{ license: { id: value } }];
      return [{ license: { name: `${type || 'declared'}:${value}` } }];
    }
  }

  const url = xml.match(/<licenseUrl>([\s\S]*?)<\/licenseUrl>/i)?.[1];
  return url ? [{ license: { name: `url:${decodeXml(url)}` } }] : [];
}

function addComponent(component) {
  const key = `${component.type}|${component.name}|${component.version ?? ''}|${component.purl ?? ''}`;
  const current = components.get(key);
  if (!current) {
    components.set(key, component);
    return;
  }

  // O mesmo pacote pode aparecer em vários projects/assets. Preserve a primeira
  // identidade e agregue fontes/licenças sem duplicar o componente no SBOM.
  const properties = [...(current.properties ?? []), ...(component.properties ?? [])];
  const uniqueProps = new Map(properties.map((p) => [`${p.name}|${p.value}`, p]));
  const licenses = [...(current.licenses ?? []), ...(component.licenses ?? [])];
  const uniqueLicenses = new Map(licenses.map((l) => [JSON.stringify(l), l]));
  components.set(key, {
    ...current,
    ...(uniqueProps.size ? { properties: [...uniqueProps.values()] } : {}),
    ...(uniqueLicenses.size ? { licenses: [...uniqueLicenses.values()] } : {}),
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function collectNpm(lockPath, ecosystem, required = true) {
  if (!existsSync(lockPath)) {
    if (required) throw new Error(`Lockfile ausente: ${relative(root, lockPath)}`);
    return;
  }
  const lock = readJson(lockPath);
  sources.push(relative(root, lockPath));

  for (const [packagePath, pkg] of Object.entries(lock.packages ?? {})) {
    if (!packagePath || !packagePath.includes('node_modules/') || !pkg?.version) continue;
    const name = pkg.name ?? packagePath.split('node_modules/').pop();
    if (!name) continue;
    const encodedName = name.startsWith('@')
      ? name.split('/').map(encodeURIComponent).join('/')
      : encodeURIComponent(name);
    const hash = integrityHash(pkg.integrity);
    const licenses = normalizeLicense(pkg.license);
    addComponent({
      type: 'library',
      name,
      version: String(pkg.version),
      purl: `pkg:npm/${encodedName}@${encodeURIComponent(String(pkg.version))}`,
      ...(hash ? { hashes: [hash] } : {}),
      ...(licenses.length ? { licenses } : {}),
      properties: [
        { name: 'renoveja:ecosystem', value: ecosystem },
        { name: 'renoveja:source', value: relative(root, lockPath) },
      ],
    });
  }
}

function walk(dir, predicate, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, predicate, out);
    else if (predicate(full)) out.push(full);
  }
  return out;
}

function collectDotnet() {
  const backend = join(root, 'backend-dotnet');
  const assetFiles = walk(backend, (path) => path.endsWith(`${join('obj', 'project.assets.json')}`));
  if (!assetFiles.length) {
    throw new Error('Nenhum project.assets.json encontrado. Rode `dotnet restore backend-dotnet/RenoveJa.sln` antes do SBOM.');
  }

  for (const assetsPath of assetFiles) {
    const assets = readJson(assetsPath);
    const packageRoot = Object.keys(assets.packageFolders ?? {})[0] ?? null;
    sources.push(relative(root, assetsPath));
    for (const [identity, meta] of Object.entries(assets.libraries ?? {})) {
      if (meta?.type !== 'package') continue;
      const slash = identity.lastIndexOf('/');
      if (slash <= 0) continue;
      const name = identity.slice(0, slash);
      const version = identity.slice(slash + 1);
      const licenses = readNugetLicense(packageRoot, name, version);
      addComponent({
        type: 'library',
        name,
        version,
        purl: `pkg:nuget/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
        ...(licenses.length ? { licenses } : {}),
        properties: [
          { name: 'renoveja:ecosystem', value: 'dotnet' },
          { name: 'renoveja:source', value: relative(root, assetsPath) },
        ],
      });
    }
  }
}

collectNpm(join(root, 'package-lock.json'), 'root', false);
collectNpm(join(root, 'frontend-web', 'package-lock.json'), 'frontend-web');
collectNpm(join(root, 'frontend-mobile', 'package-lock.json'), 'frontend-mobile');
collectDotnet();

const sorted = [...components.values()].sort((a, b) =>
  `${a.purl ?? a.name}`.localeCompare(`${b.purl ?? b.name}`));
const timestamp = new Date().toISOString();

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp,
    component: {
      type: 'application',
      name: 'RenoveJa+',
      version: process.env.GITHUB_SHA?.slice(0, 12) || 'working-tree',
    },
    tools: [{ vendor: 'RenoveJa', name: 'scripts/security/generate-sbom.mjs', version: '2' }],
    properties: [
      { name: 'renoveja:git-sha', value: process.env.GITHUB_SHA || 'unknown' },
      { name: 'renoveja:source-count', value: String(new Set(sources).size) },
    ],
  },
  components: sorted,
};

const byEcosystem = {};
for (const component of sorted) {
  const ecosystems = new Set((component.properties ?? [])
    .filter((p) => p.name === 'renoveja:ecosystem')
    .map((p) => p.value));
  for (const ecosystem of ecosystems) byEcosystem[ecosystem] = (byEcosystem[ecosystem] ?? 0) + 1;
}

const licensedCount = sorted.filter((component) => (component.licenses ?? []).length > 0).length;
const inventory = {
  generatedAt: timestamp,
  gitSha: process.env.GITHUB_SHA || null,
  componentCount: sorted.length,
  componentsWithDeclaredLicense: licensedCount,
  componentsWithoutDeclaredLicense: sorted.length - licensedCount,
  byEcosystem,
  sources: [...new Set(sources)].sort(),
  reviewBoundary: 'Inventário técnico. Licença declarada por pacote não substitui análise jurídica de compatibilidade, notices ou obrigações de distribuição.',
};

writeFileSync(join(outputDir, 'sbom.cdx.json'), `${JSON.stringify(sbom, null, 2)}\n`);
writeFileSync(join(outputDir, 'dependency-inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);

console.log(`SBOM CycloneDX: ${sorted.length} componentes; licença declarada em ${licensedCount}.`);
console.log(`Por ecossistema: ${JSON.stringify(byEcosystem)}`);
console.log(`Saída: ${relative(root, join(outputDir, 'sbom.cdx.json'))}`);
