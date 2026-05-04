# ANÁLISE COMPARATIVA — CPRB × FOLHA CHEIA

**Empresas:** Montana Assessoria Empresarial Ltda (CNPJ 14.092.519/0001-51) e Montana Segurança Privada Ltda (CNPJ 19.200.109/0001-09)
**Regime tributário (IRPJ/CSLL):** Lucro Real — ambas
**Data-base:** 25/04/2026
**Período de referência:** últimos 12 meses fechados
**Status:** documento de trabalho — números preenchidos pelo script `scripts/analise_cprb_comparativo.js`

---

## 1. Sumário executivo

A **Contribuição Previdenciária sobre a Receita Bruta (CPRB)** — popularmente "desoneração da folha" — substitui parcialmente a contribuição patronal de 20% sobre a folha de pagamento por uma alíquota incidente sobre a receita bruta. Vigilância (CNAE 80) e limpeza/conservação (CNAE 81.21) estão **expressamente listadas** entre os setores beneficiados pela Lei 12.546/2011 desde sua origem.

A partir de 01/01/2025, a Lei 14.973/2024 instituiu **regime de transição** (reoneração gradual) com extinção total da CPRB em 31/12/2027. Em 2026 (ano corrente), o regime é **misto** — paga-se uma fração da CPRB sobre receita E uma fração da contribuição patronal sobre a folha.

**Conclusão antecipada (a confirmar com os números reais):** para empresas de mão-de-obra intensiva como vigilância e limpeza, a CPRB tipicamente continua **vencendo** a folha cheia mesmo no regime de transição, porque a folha representa parcela relevante da receita bruta — em geral entre 65% e 85%. A confirmação definitiva depende dos números deste relatório.

> **Alerta de calendário (crítico):** a opção pela CPRB é feita pelo **recolhimento da primeira competência do ano** (DARF código 2985, competência janeiro, vencimento fevereiro) e é **irretratável durante todo o ano-calendário**. Logo:
> - **2026 já está selado** — verificar no Passo 1 se as empresas estão na CPRB ou na folha cheia.
> - **2027 precisa ser decidido até janeiro/2027** com cálculo concluído.

---

## 2. Fundamento legal

### 2.1. Regra-mãe — Lei 12.546/2011

**Art. 7º — Vigilância e segurança privada (inciso V):**
> "Contribuirão sobre o valor da receita bruta, excluídos os impostos não cumulativos faturados e as vendas canceladas, à alíquota de **4,5%**, em substituição às contribuições previstas nos incisos I e III do caput do art. 22 da Lei 8.212/1991, as empresas de **vigilância, segurança e transporte de valores**."

**Art. 7º — Limpeza e conservação (inciso IV):**
> "As empresas que prestam os serviços de **limpeza, conservação e zeladoria** classificados nas subclasses 8121-4/00 e 8129-0/00 da CNAE 2.0."

**Art. 9º, §13 — Caráter da opção:**
> "A opção pela tributação substitutiva (...) será manifestada mediante o pagamento da contribuição incidente sobre a receita bruta relativa a janeiro de cada ano (...), sendo **irretratável para todo o ano-calendário**."

### 2.2. Regime de transição — Lei 14.973/2024

| Ano | % CPRB sobre receita | % patronal sobre folha | Observação |
|:---:|:---:|:---:|---|
| 2024 | 100% × alíquota base | 0% | Regime cheio CPRB |
| 2025 | 80% × alíquota base | 25% × 20% = 5% | Misto |
| **2026** | **60% × alíquota base** | **50% × 20% = 10%** | **Ano corrente — misto** |
| 2027 | 40% × alíquota base | 75% × 20% = 15% | Misto |
| 2028 | — | 20% (cheio) | CPRB extinta |

> **Observação técnica:** os percentuais de transição acima refletem a leitura corrente da Lei 14.973/2024. **Confirmar com a contabilidade** antes do recolhimento, pois pode haver IN da RFB ou medida provisória que altere o calendário. O script de cálculo trata os percentuais como parâmetros editáveis.

### 2.3. O que **continua** na folha em qualquer cenário

A CPRB substitui **apenas** a contribuição patronal previdenciária (incisos I e III do art. 22 da Lei 8.212/91 — 20% sobre folha). **Permanecem na folha em todos os cenários**:

- **RAT/SAT** (Risco Ambiental do Trabalho) — 1% / 2% / 3% conforme grau de risco do CNAE preponderante, ajustado pelo FAP.
- **Terceiros (Sistema S)** — alíquota total ~5,8% (INCRA, SENAI, SESI, SEBRAE, Salário-Educação etc.).
- **FGTS** — 8%.
- **INSS retido do empregado** — 7,5% a 14% (descontado, não é custo da empresa).

### 2.4. Códigos e obrigações acessórias

- **DARF CPRB:** código de receita **2985**.
- **EFD-Reinf:** evento **R-2060** declara a base de cálculo da CPRB mensalmente.
- **DCTFWeb:** consolida CPRB junto com folha residual e demais contribuições.

---

## 3. Metodologia da comparação

Para cada uma das duas empresas, e para cada um dos últimos 12 meses fechados, comparar três cenários:

### Cenário A — Folha cheia (sem CPRB)
```
INSS_patronal_A = folha_bruta × 20%
RAT_A           = folha_bruta × aliq_RAT_FAP
Terceiros_A     = folha_bruta × 5,8%
TOTAL_A         = INSS_patronal_A + RAT_A + Terceiros_A
```

### Cenário B — CPRB transição 2026 (60/50)
```
CPRB_B          = receita_bruta × (4,5% × 60%) = receita_bruta × 2,70%
INSS_patronal_B = folha_bruta × (20% × 50%)    = folha_bruta × 10%
RAT_B           = folha_bruta × aliq_RAT_FAP
Terceiros_B     = folha_bruta × 5,8%
TOTAL_B         = CPRB_B + INSS_patronal_B + RAT_B + Terceiros_B
```

### Cenário C — CPRB regime cheio (referência teórica/histórica)
```
CPRB_C          = receita_bruta × 4,5%
INSS_patronal_C = 0
RAT_C           = folha_bruta × aliq_RAT_FAP
Terceiros_C     = folha_bruta × 5,8%
TOTAL_C         = CPRB_C + RAT_C + Terceiros_C
```

### Resultado por empresa
- **Caixa mensal em jogo (2026):** A − B
- **Caixa mensal teórico (regime cheio):** A − C *(referência histórica; não aplicável em 2026)*
- **Caixa anual projetado:** soma dos 12 meses

### Premissas configuráveis (default no script)

| Parâmetro | Assessoria | Segurança |
|---|---:|---:|
| Alíquota CPRB base | 4,5% | 4,5% |
| % CPRB transição 2026 | 60% | 60% |
| % patronal residual 2026 | 50% (= 10% folha) | 50% (= 10% folha) |
| RAT × FAP | 2,0% | 3,0% |
| Terceiros (Sistema S) | 5,8% | 5,8% |

> **Confirmar com a contabilidade:**
> - alíquota RAT efetiva (depende do CNAE preponderante de cada CNPJ);
> - FAP vigente para 2026 (consulta no e-Social/Receita);
> - se há atividade não-elegível à CPRB compondo a receita (a parcela não-elegível sai da base CPRB e a folha proporcional volta cheia).

---

## 4. Carteira de contratos vs. elegibilidade CPRB

Com base no parecer interno de IRRF (`PARECER_IRRF_VIGILANCIA_LIMPEZA_2026-04-17.md`), a carteira é integralmente composta por serviços listados na CPRB:

| Empresa | Serviços prestados | Inciso Lei 12.546/2011 | Elegibilidade |
|---|---|:---:|:---:|
| Assessoria | Limpeza, conservação, copeiragem, locação MO (motoristas) | art. 7º, IV | **Total** |
| Segurança | Vigilância patrimonial armada e desarmada | art. 7º, V | **Total** |

> **Atenção:** a locação de motoristas (contrato UFT MOTORISTA 05/2025) é, em estrito direito, "locação de mão de obra" — também listada no art. 7º, IV. **Confirmar com a contabilidade** se está sendo tratada como CPRB-elegível.

---

## 5. Resultados consolidados (preenchido pelo script)

> Esta seção é gerada automaticamente por `scripts/analise_cprb_comparativo.js`.
> Veja o XLSX produzido em `output/CPRB_Comparativo_<periodo>.xlsx` para a memória de cálculo mês a mês.

### 5.1. Montana Assessoria Empresarial Ltda

```
[ preenchido pelo script ]
Receita bruta 12m:                  R$ ___________
Folha bruta 12m:                    R$ ___________
Folha / Receita:                    ____,_%

Cenário A — Folha cheia 12m:        R$ ___________
Cenário B — CPRB 2026 12m:          R$ ___________
Cenário C — CPRB cheio (ref) 12m:   R$ ___________

CAIXA EM JOGO 2026 (A − B):         R$ ___________ (vence ___)
CAIXA TEÓRICO (A − C):              R$ ___________ (vence ___)
```

### 5.2. Montana Segurança Privada Ltda

```
[ preenchido pelo script ]
Receita bruta 12m:                  R$ ___________
Folha bruta 12m:                    R$ ___________
Folha / Receita:                    ____,_%

Cenário A — Folha cheia 12m:        R$ ___________
Cenário B — CPRB 2026 12m:          R$ ___________
Cenário C — CPRB cheio (ref) 12m:   R$ ___________

CAIXA EM JOGO 2026 (A − B):         R$ ___________ (vence ___)
CAIXA TEÓRICO (A − C):              R$ ___________ (vence ___)
```

### 5.3. Consolidado Grupo Montana

```
[ preenchido pelo script ]
Caixa anual em jogo (A − B):        R$ ___________
Caixa anual teórico (A − C):        R$ ___________
```

---

## 6. Roteiro de confirmação — antes de qualquer mudança

### Passo 1 — Descobrir o regime atual de cada empresa (1 hora)
Solicitar à contabilidade, por empresa, das competências **jan/2025, jan/2026 e a última fechada**:
1. **DARF recolhido** — verificar presença do código **2985** (= CPRB) ou GPS/DCTFWeb com 20% patronal (= folha cheia).
2. **EFD-Reinf** — evento **R-2060** com base CPRB ou ausência dele.
3. **DCTFWeb** consolidada do mês.

### Passo 2 — Validar premissas técnicas (30 min)
- Alíquota **RAT** efetiva do CNAE preponderante de cada CNPJ.
- **FAP** vigente para 2026.
- Confirmar redação atual da Lei 14.973/2024 e qualquer IN/MP posterior.

### Passo 3 — Rodar o comparativo com dados reais
```bash
node scripts/analise_cprb_comparativo.js --periodo=2025-04..2026-03
```
Resultado: XLSX em `output/CPRB_Comparativo_*.xlsx` e atualização das seções 5.x deste documento.

### Passo 4 — Decisão e protocolo
- **Se 2026 estiver na folha cheia e CPRB vencer:** caixa de 2026 está perdido; preparar opção para **jan/2027** (recolhimento DARF 2985 referente a competência 01/2027, vencimento 20/02/2027).
- **Se 2026 já estiver na CPRB:** validar se base, alíquota e percentual de transição estão corretos (auditar EFD-Reinf dos 12 meses).
- **Se a opção atual for sub-ótima:** documentar memória de cálculo e instruir a contabilidade a alterar a partir do próximo exercício.

### Passo 5 — Olhar para trás (recuperação eventual)
- **Não há recuperação retroativa** se a empresa pagou folha cheia podendo estar na CPRB — a opção é prospectiva.
- **Há recuperação possível (5 anos)** se houve recolhimento CPRB **a maior** (alíquota errada, base errada, inclusão indevida de receitas não-elegíveis, não aproveitamento da exclusão de impostos não-cumulativos faturados, etc.). Via **PER/DCOMP**.

---

## 7. Riscos e armadilhas conhecidas

1. **Receita mista** — se houver receita não-elegível (ex.: revenda de mercadoria, serviços fora do art. 7º), a parcela não-elegível sai da base CPRB e a folha correspondente volta cheia (proporcionalização — Lei 12.546/2011, art. 9º, §1º).
2. **CNAE preponderante divergente** — se o CNAE registrado na Receita não for o efetivamente exercido, a fiscalização pode glosar a CPRB. Conferir CNAE primário e secundários no CNPJ.
3. **Vigilância armada vs. desarmada** — ambas são art. 7º, V (vigilância em geral). Não há a controvérsia que existe no IRRF.
4. **Contratos públicos com retenção de INSS** — a CPRB **não exclui** a retenção do art. 31 da Lei 8.212/91 quando o contrato a prevê. As duas coisas convivem.
5. **Folha próxima a 0** (postos com poucos colaboradores e contrato pequeno) — em casos extremos, folha cheia pode vencer CPRB. O script identifica isso mês a mês.

---

## 8. Próximos passos

- [ ] Rodar `node scripts/analise_cprb_comparativo.js` e revisar o XLSX gerado.
- [ ] Confirmar com a contabilidade os 3 documentos do Passo 1 (regime atual).
- [ ] Validar RAT e FAP de cada CNPJ.
- [ ] Decidir, em conjunto com a contabilidade, a opção para **2027**.
- [ ] Se houver indício de recolhimento a maior em CPRB no passado, abrir levantamento para PER/DCOMP.

---

## 9. Apêndice — checklist de documentos a solicitar à contabilidade

Para **cada empresa**, **cada competência** das datas-chave (jan/2025, jan/2026, última fechada):

- [ ] DARF recolhido (qualquer código que apareça)
- [ ] GPS / DCTFWeb da competência
- [ ] EFD-Reinf — eventos R-1000, R-2010, R-2060 (se houver)
- [ ] eSocial — folha de pagamento consolidada
- [ ] FAP do ano-calendário
- [ ] Cartão CNPJ atualizado (CNAE primário e secundários)

Para **levantamento histórico** (eventual PER/DCOMP):
- [ ] DARFs CPRB últimos 60 meses (se houve CPRB)
- [ ] Memórias de cálculo da CPRB últimos 60 meses
- [ ] Receita bruta segregada (CPRB-elegível × não-elegível) últimos 60 meses
