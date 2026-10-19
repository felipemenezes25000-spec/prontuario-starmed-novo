# Valida um XML TISS contra o esquema oficial da ANS (schemas/tiss/4.01.00/).
# Sem dependências nativas: usa System.Xml.Schema.XmlSchemaSet do PowerShell/.NET.
# Uso:
#   pwsh scripts/tiss/validate-tiss.ps1 -Xml arquivo.xml
#   npx tsx -e "..." | pwsh scripts/tiss/validate-tiss.ps1 -  (stdin com '-')
param(
  [Parameter(Mandatory = $true)][string]$Xml,
  [string]$SchemaDir = ''
)

$ErrorActionPreference = 'Stop'
if (-not $SchemaDir) {
  $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
  $SchemaDir = Join-Path $scriptDir '..\..\schemas\tiss\4.01.00'
}

# Resolver local-only: resolve os <include>/<import> dos XSDs apenas por nome de arquivo
# dentro do próprio diretório de schemas (File.OpenRead). Rede nunca é alcançada —
# nenhuma confiança nova entra por aqui.
Add-Type -ReferencedAssemblies @('System.Xml', 'System') -TypeDefinition @'
public class LocalSchemaResolver : System.Xml.XmlResolver {
  private readonly string _root;
  public LocalSchemaResolver(string root) { _root = root; }
  public override System.Uri ResolveUri(System.Uri baseUri, string relativeUri) {
    if (string.IsNullOrEmpty(relativeUri)) return null;
    var name = System.IO.Path.GetFileName(relativeUri);
    return new System.Uri(System.IO.Path.Combine(_root, name));
  }
  public override object GetEntity(System.Uri absoluteUri, string role, System.Type typeToReturn) {
    return System.IO.File.OpenRead(absoluteUri.LocalPath);
  }
}
'@
$schemaPath = Join-Path $SchemaDir 'tissV4_01_00.xsd'
if (-not (Test-Path $schemaPath)) { Write-Error "XSD não encontrado: $schemaPath"; exit 2 }

$localResolver = New-Object LocalSchemaResolver((Resolve-Path $SchemaDir).Path)
$schemaSet = New-Object System.Xml.Schema.XmlSchemaSet
$schemaSet.XmlResolver = $localResolver
# Os XSDs são locais e confiáveis; o xmldsig do W3C declara DOCTYPE (referência ao
# XMLSchema.dtd do W3C, irrelevante para a validação) — Ignore pula o DTD sem tentar
# resolvê-lo. O XML DE ENTRADA continua com DTD totalmente proibido.
$schemaReadSettings = New-Object System.Xml.XmlReaderSettings
$schemaReadSettings.DtdProcessing = [System.Xml.DtdProcessing]::Ignore
$schemaReadSettings.XmlResolver = $localResolver
# O tissV4_01_00.xsd importa o xmldsig (assinatura digital) — declaramos antes para o resolver local.
$dsReader = [System.Xml.XmlReader]::Create((Join-Path $SchemaDir 'xmldsig-core-schema.xsd'), $schemaReadSettings)
$schemaSet.Add('http://www.w3.org/2000/09/xmldsig#', $dsReader) | Out-Null
$reader = [System.Xml.XmlReader]::Create($schemaPath, $schemaReadSettings)
$schemaSet.Add('http://www.ans.gov.br/padroes/tiss/schemas', $reader) | Out-Null
$schemaSet.Compile()

if ($Xml -eq '-') {
  $content = [Console]::In.ReadToEnd()
} else {
  if (-not (Test-Path $Xml)) { Write-Error "XML não encontrado: $Xml"; exit 2 }
  $content = Get-Content $Xml -Raw
}

$settings = New-Object System.Xml.XmlReaderSettings
$settings.Schemas = $schemaSet
$settings.ValidationType = [System.Xml.ValidationType]::Schema
$settings.XmlResolver = $null
$errors = @()
$action = {
  param($s, $e)
  $script:errors += "Linha $($e.Exception.LineNumber): $($e.Message)"
}
$settings.add_ValidationEventHandler($action)

$stringReader = New-Object System.IO.StringReader($content)
$xmlReader = [System.Xml.XmlReader]::Create($stringReader, $settings)
try {
  while ($xmlReader.Read()) { }
} catch {
  $errors += "Falha de leitura: $($_.Exception.Message)"
} finally {
  $xmlReader.Close()
}

if ($errors.Count -gt 0) {
  Write-Host "INVALIDO contra tissV4_01_00.xsd ($($errors.Count) erro(s)):"
  $errors | ForEach-Object { Write-Host "  $_" }
  exit 1
}
Write-Host 'VALIDO: XML em conformidade com o esquema oficial TISS 4.01.00 da ANS.'
exit 0
