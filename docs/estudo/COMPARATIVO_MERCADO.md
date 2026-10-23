# Comparativo de mercado — o que cada sistema DECLARA publicamente × o que o StarMed COMPROVA

- **Data da pesquisa:** 23/10/2026.
- **Método:** pesquisa documental em fontes públicas: site do fornecedor, documentação, PDFs da SBIS, órgãos públicos, imprensa e Reclame Aqui. Sem login, sem material restrito, sem engenharia reversa.

## 0. Limites — leia antes de usar qualquer linha

- **Ausência de declaração ≠ ausência de recurso.** "Não encontrado publicamente" significa que o fornecedor não divulga, não que não tenha.
- **Os concorrentes aparecem pelo que declaram; o StarMed, pelo que tem em código e teste automatizado.** É uma assimetria: o StarMed não tem nenhum cliente nem homologação externa. Os concorrentes têm milhares de clientes.
- **Nenhuma linha mede usabilidade ou tempo de tarefa.** Isso só o estudo controlado mede ([PROTOCOLO_ESTUDO_COMPARATIVO.md](PROTOCOLO_ESTUDO_COMPARATIVO.md)).
- **Lista de certificados SBIS:** a página de sistemas vigentes retornou 404 em 23/10/2026. O status de certificação vem dos PDFs individuais e da lista de **expirados** (maio/2026); uma renovação posterior não pode ser descartada.
- **Este documento não autoriza alegação de marketing.**

## 1. Síntese

Legenda: ✅ = declarado (concorrentes) ou comprovado em código e teste (StarMed) · ⚠️ = parcial ou com ressalva · ❌ = não encontrado publicamente (concorrentes) ou ausente (StarMed) · 🔒 = verificado por terceiro.

| Dimensão | StarMed | Bionexo Tasy (ex-Philips) | MV (Soul MV) | iClinic (Afya) | Feegow (Doctoralia) | Epic | Oracle Health |
|---|---|---|---|---|---|---|---|
| Segmento | Ambulatório (piloto pendente) | Hospital, operadoras | Hospital, SUS, operadora, clínica | Consultório até rede (70 mil profissionais) | Clínicas e redes | Hospitais EUA (56,9% dos leitos) | Hospitais EUA e governo; Einstein (2013) |
| **Clientes reais** | ❌ nenhum | ✅ | ✅ (894 hospitais LatAm, declarado) | ✅ | ✅ | ✅ | ✅ |
| **Certificação SBIS** | ❌ (matriz NGS2 interna) | 🔒 NGS2 vigente até 05/2028 | ⚠️🔒 consta como **expirado** em 08/2024; site ainda alega | ❌ | ⚠️🔒 consta como **expirado** em 09/2024; site ainda exibe selo | não se aplica | não se aplica |
| Assinatura ICP-Brasil | ⚠️ PAdES no código e E2E com CA de teste; **sem validação ITI real** | ✅ via CertiSign, Soluti e ForSign | ❌ | ✅ | ❌ | ❌ | ❌ |
| Memed ou base própria de prescrição | ❌ (campos estruturados próprios) | ✅ Memed e Mevo | ❌ | ✅ base própria (iClinicRx) | ❌ | n/a (EUA) | n/a |
| Base farmacológica **licenciada** (interação, dose) | ❌ (só alergia e duplicidade por princípio ativo) | ✅ Micromedex | ⚠️ "bases de conhecimento" sem nome | ❌ | ❌ | ✅ Medi-Span, Lexidrug ou FDB | ✅ Multum |
| Bloqueio por substância controlada (Portaria 344) em receita simples | ✅ 78 substâncias, só bloqueia | ❌ | ❌ | ❌ | ❌ | n/a | n/a |
| SNCR / controle especial eletrônico | ❌ bloqueado (honesto) | ❌ | ❌ | ❌ | ❌ | n/a | n/a |
| Verificação pública da receita (QR) sem expor medicamento | ✅ | ❌ | ❌ | ❌ | ❌ | n/a | n/a |
| CRM/UF obrigatório para assinar | ✅ 422 sem registro | ❌ | ❌ | ❌ | ❌ | n/a | n/a |
| FHIR R4 | ✅ validador **oficial HL7 no CI** + CapabilityStatement | ⚠️ citado por revendedor, sem versão | ❌ | ❌ | ⚠️ "API" sem documentação | ✅ fhir.epic.com, Bulk, CDS Hooks | ✅ R4 + SMART v1/v2 |
| SMART on FHIR | ⚠️ discovery honesto (sem servidor de autorização) | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| RNDS | ⚠️ identificadores e mappers prontos; **sem homologação** | ❌ | ❌ | ❌ | ❌ | n/a | n/a |
| TISS | ⚠️ XSD 4.01 validado no CI; sem operadora | ❌ | ❌ | ✅ (plano Plus) | ✅ | n/a | n/a |
| Teleconsulta | ✅ WebRTC com E2E (gravação desligada por decisão) | ⚠️ link por e-mail | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| Portal do paciente | ✅ (documentos com re-hash, LGPD, opt-out) | ❌ | ✅ | ❌ | ❌ | ✅ MyChart | ✅ |
| IA clínica | ⚠️ extração com proveniência, anti-injeção e dataset de avaliação; **sem modelo real validado** | ⚠️ só intenção | ✅ med.ai + Sofya | ✅ transcrição + "hipóteses diagnósticas" | ⚠️ "Prontuário com IA" | ✅ AI Charting (02/2026) | ✅ Clinical AI Agent |
| **Governança/validação de IA publicada** | ⚠️ interna (provenance, revisão humana, testes adversariais) | ❌ | ❌ | ⚠️ não treina com dados (beta) | ❌ | ✅ Seismometer (open source) | ❌ |
| Isolamento multi-tenant **testado** | ✅ RLS + papel não-owner + drill no CI | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| MPI / deduplicação | ✅ determinístico + Jaro-Winkler, sem auto-merge | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Acessibilidade declarada | ✅ WCAG 2.2 AA com axe sem violações sérias nas jornadas | ❌ | ❌ | ❌ | ❌ | ⚠️ MyChart WCAG 2.1 | ✅ VPAT WCAG 2.2 |
| ISO 27001 / SOC 2 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Pentest independente | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Preço público | ❌ | ❌ | ❌ | ✅ R$ 99–299/profissional/mês | ❌ | ❌ | ❌ |
| Problemas públicos relevantes | — (sem uso real) | 🔒 ALMG/Fhemig 06/2026: lentidão e quedas | não encontrados | 🔒 Reclame Aqui 6,4 "Regular" (instabilidade, cobrança) | 🔒 Reclame Aqui: venda com promessa não cumprida | — | 🔒 invasão de servidores legados (2025), apagões (2025), OIG/VA (2022) |

## 2. Onde o StarMed está à frente — e por que isso ainda não vira alegação

Nenhum concorrente declara publicamente estas proteções. O StarMed as **comprova em teste automatizado**:

1. **Receita que não sai errada.**
   - CRM/UF obrigatório para assinar.
   - Controlado bloqueado em receita simples; antimicrobiano exige o tipo próprio.
   - Alergia checada pelo princípio ativo ("Novalgina" × dipirona).
2. **Verificação pública da receita sem vazar diagnóstico.** Sem o código, a página não mostra o medicamento.
3. **Interoperabilidade auditável.** O validador FHIR **oficial** da HL7 roda a cada commit, com gate negativo.
4. **Isolamento entre clínicas provado.** RLS com papel não-owner e drill cross-tenant no CI.
5. **Honestidade de estado.** Atestado ≠ assinatura ICP; "sem alergia registrada" ≠ "sem alergia"; IA nunca assina.

**Por que não é alegação ainda:**
- Nada disso foi usado por médico real nem homologado.
- Os concorrentes podem ter essas proteções e simplesmente não divulgá-las.
- O máximo defensável hoje: *"o StarMed implementa e testa automaticamente as proteções X, Y e Z"*.

## 3. Onde o StarMed está atrás (o que pesa na decisão de compra)

| Lacuna | Quem já tem | Peso |
|---|---|---|
| **Zero clientes e zero histórico de operação** | Todos | Decisivo |
| Certificação SBIS | Tasy (vigente) | Alto em hospital e rede; exigência em editais |
| Assinatura ICP-Brasil **validada no ITI** + integração Memed | Tasy, iClinic | Alto: sem isso a receita digital não circula |
| Base farmacológica licenciada (interações, dose) | Tasy (Micromedex), Epic, Oracle | Alto para segurança medicamentosa real |
| IA de transcrição funcionando com modelo real | MV, iClinic, Epic, Oracle | Alto em ambulatório (é o que vende hoje) |
| Profundidade de gestão (faturamento, estoque, ERP hospitalar) | Tasy, MV | Alto em hospital; menor em consultório |
| Preço e plano publicados, suporte e onboarding | iClinic | Médio–alto em consultório |

## 4. Oportunidades — buracos do mercado inteiro

1. **Selos SBIS desatualizados.** Dois concorrentes exibem certificação que consta como expirada. Ser **certificado e transparente** (selo com número e validade checáveis) diferencia.
2. **IA sem governança publicada.** Ninguém no Brasil divulga validação dos scribes, nem os que sugerem diagnóstico e prescrição. Publicar avaliação, limitações e taxa de erro (o StarMed já tem dataset e scorer) é diferencial real e defensável.
3. **FHIR/RNDS documentado.** Nenhum concorrente brasileiro documenta API FHIR pública. Documentação aberta, no padrão do fhir.epic.com, atrai integradores.
4. **Acessibilidade.** Nenhum concorrente brasileiro declara WCAG. O StarMed já tem axe zerado nas jornadas; falta um VPAT público.
5. **Confiabilidade transparente.** Os casos Fhemig e Oracle mostram o custo da instabilidade. Página de status e SLA publicados.

## 5. Próximos passos (ordem de impacto comercial × esforço)

1. Integrar **Memed** (ou base própria licenciada) e fazer a validação **ITI** com certificado real (PLANO_HOMOLOGACOES 2.1).
2. Ligar a **IA de transcrição** a um provedor real, rodar o avaliador sobre o dataset e **publicar** o resultado.
3. Iniciar o **gap analysis SBIS** com o manual vigente (2.5).
4. Fazer o **piloto** ([PROTOCOLO_PILOTO.md](PROTOCOLO_PILOTO.md)). O primeiro cliente real vale mais que qualquer item acima.
5. Rodar o **estudo comparativo** com iClinic e, se houver acesso legítimo, MV ou Tasy no mesmo segmento.

## 6. Fontes (acessadas em 23/10/2026)

- **Tasy:**
  - [Fato Relevante Bionexo (30/12/2025)](https://acionista.com.br/wp-content/uploads/2025/12/BIONEXO_S.A.-Comunicado_ao_Mercado-Declaracao_de_Aquisicao_de_Participacao_Acionaria_Relevante-30-12-2025.pdf)
  - [Portal ERP (04/05/2026)](https://portalerp.com/br/noticia/bionexo-conclui-aquisicao-do-tasy-e-lanca-a-bionexo-tasy-plataforma-integrada-que-conecta-o-ecossistema-de-saude-na-america-latina)
  - [SBIS cert. 190](https://sbis.org.br/wp-content/uploads/2026/05/190.pdf) · [cert. 193](https://sbis.org.br/wp-content/uploads/2026/05/193.pdf)
  - [Futuro da Saúde (integrações)](https://futurodasaude.com.br/philips-tasy-integracao-parceiros/)
  - [Merative/Micromedex](https://merative.com/content/dam/merative/documents/brief/mdx-5337567762-philips-tasy-integration-portuguese-a4-ds-1.pdf)
  - [ALMG/Fhemig (02/06/2026)](https://www.almg.gov.br/comunicacao/noticias/arquivos/Novo-sistema-da-Fhemig-estaria-afetando-atendimentos-de-urgencia/)
- **MV:**
  - [mv.com.br](https://mv.com.br/) · [PEP MV](https://mv.com.br/produto/pep) · [med.ai](https://mv.com.br/solucao/medai) · [Teleconsulta](https://mv.com.br/produto/teleconsulta)
  - [Investimento na Sofya (13/09/2025)](https://movimentoeconomico.com.br/saude/2025/09/13/mv-acelera-transformacao-digital-da-saude-com-investimento-na-sofya/)
- **SBIS:** [lista de certificados expirados (05/2026)](https://sbis.org.br/wp-content/uploads/2026/05/Certificados-Expirados.pdf)
- **iClinic:**
  - [site](https://www.iclinic.com.br/) · [preços](https://www.iclinic.com.br/precos/)
  - [termos de IA](https://intercom.help/iclinic-bc30384852a6/pt-BR/articles/9740385-otimizacao-de-prontuario-adendo-termo-e-condicoes-de-uso-da-iclinic)
  - [Reclame Aqui](https://www.reclameaqui.com.br/empresa/iclinic/lista-reclamacoes/)
- **Feegow:**
  - [site](https://feegowclinic.com.br/)
  - [aquisição pela Doctoralia](https://startups.com.br/noticias/doctoralia-compra-brasileira-feegow-e-mira-gestao-para-clinicas)
  - [Reclame Aqui](https://www.reclameaqui.com.br/feegow/cancelamento-e-reembolso_20N2Ril3JcEkwNqN/)
- **Amplimed:** [site](https://www.amplimed.com.br/)
- **Epic:**
  - [fhir.epic.com](https://fhir.epic.com/)
  - [participação de mercado (KLAS 2026)](https://fiercehealthcare.com/health-tech/epic-continues-grow-ehr-market-share-it-makes-gains-small-health-systems)
  - [AI Charting](https://www.fiercehealthcare.com/ai-and-machine-learning/epic-rolls-out-ai-charting-and-more-built-automation-clinicians-and)
  - [Seismometer](https://www.healthcareitnews.com/news/epic-leads-new-effort-democratize-health-ai-validation)
  - [Best in KLAS 2026](https://engage.klasresearch.com/press-release/epic-athenahealth-chartis-optimum-healthcare-it-and-impact-advisors-win-2026-overall-best-in-klasawards/)
- **Oracle Health:**
  - [FHIR R4](https://docs.oracle.com/en/industries/health/millennium-platform-apis/mfrap/r4_overview.html)
  - [certificação ONC (11/2025)](https://www.oracle.com/nl/news/announcement/onc-certification-oracle-ehr-marks-turning-point-for-healthcare-industry-2025-11-18/)
  - [invasão de servidores (2025)](https://bleepingcomputer.com/news/security/oracle-health-breach-compromises-patient-data-at-us-hospitals)
  - [OIG/VA](https://www.oversight.gov/reports/new-electronic-health-records-unknown-queue-caused-multiple-events-patient-harm)
  - [ACR/VPAT](https://www.oracle.com/nl/corporate/accessibility/templates/t2-16077.html)
- **Usabilidade de EHRs (geral):** [Melnick et al., SUS ≈ 45](https://medicine.yale.edu/news-article/21820/)
