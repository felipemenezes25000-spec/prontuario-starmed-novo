# Esquemas TISS 4.01.00 — procedência

Arquivos oficiais da ANS, **sem edição**, usados só em teste (`StarMedTissOfficialSchemaTests`).
Em produção o esquema continua sendo carregado pela administração (`StarMedTissSchemasController`).

- Página: <https://www.gov.br/ans/pt-br/assuntos/prestadores/padrao-para-troca-de-informacao-de-saude-suplementar-2013-tiss/padrao-tiss-marco-2025>
- Pacote: `PadroTISSComunicao202301.zip` (Componente de Comunicação 04.01.00 e 01.04.01),
  SHA-256 `63f724f73ba66a5040f02c336567665f41ea0f451bda627ad7fb9c02fd2e9862`, baixado em 24/09/2026.
- Dentro dele, `Padrão TISS Comunicação 040100.zip`: os `.xsd` abaixo. Os `.wsdl` ficaram de fora
  (descrevem o transporte por web service, não o conteúdo do lote).

| Arquivo | SHA-256 |
| --- | --- |
| tissV4_01_00.xsd | 3293d4a0b0e053b89c1b6eebe57f282c217dfbac3fa6e74848f07717639258f1 |
| tissComplexTypesV4_01_00.xsd | 98a7626e341f5ebc7ec0da2bc8252cdc32879faa58376dfd3c62d62610319ef1 |
| tissSimpleTypesV4_01_00.xsd | 54f3bfdc387d24539674e4bbb64c32a5cb7ebd6a7509f79ed385566e673c1309 |
| tissGuiasV4_01_00.xsd | 0546c15b0f100ae9a1f1d0e840ed0e5e602ae9dff415dcf86f814745f2823cb1 |
| tissWebServicesV4_01_00.xsd | d470cdf1b492673b00b2c9b684383496b5ca63988b0881b0f9068cdbd3771f38 |
| tissAssinaturaDigital_v1.01.xsd | 8567690a0eb05b9681fdc575ca7c867f75bf5cb33573175b8d333617ef035221 |
| xmldsig-core-schema.xsd | b6388292d746c6cc8f932ce3b6bf7c7fc0bf6cba58ec385b38988887bcf5fdbb |

O teste confere estes hashes: arquivo alterado reprova, para ninguém "consertar" o esquema da ANS
para o lote passar.
