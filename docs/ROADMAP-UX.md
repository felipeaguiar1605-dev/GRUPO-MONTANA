# Roadmap UX — Montana ERP

Lista de melhorias de usabilidade para operadores trabalharem **sem Claude Code**, com revisão e correção.

Atualizada em 2026-05-04.

## Prioridades

- 🔴 **Alta**: bloqueia operação rotineira ou exige conhecimento técnico
- 🟡 **Média**: melhora muito o dia a dia mas tem workaround
- 🟢 **Baixa**: polimento, governança, opcional

---

## 1. Cadastro de postos e itens
**Prioridade**: 🔴 Alta

**Hoje**: cadastro de novos postos (ex: 11 do DETRAN faltantes) só via SQL direto.

**Precisa**:
- Tela "Editar Contrato" → aba "Postos" → botão "+ Adicionar Posto"
- Dentro do posto: lista de itens (descrição, qtd, valor unitário) editável inline
- Validação: campus_key único por contrato, valor positivo

**Endpoint backend**: provavelmente já existe `/api/boletins/contratos/:id/postos` (verificar)

---

## 2. Geração em lote de boletins por posto
**Prioridade**: 🔴 Alta

**Hoje**: só via script Node `/tmp/gerar-boletins-detran.js`.

**Precisa**:
- Botão "📋 Gerar N boletins" na linha do contrato (quando `qtd_postos > 1`)
- Modal de confirmação: "Vai criar N boletins (1 por posto). Apagar rascunhos existentes? [Sim/Não]"
- Chama `/api/boletins/_gerar-por-postos` (já existe)
- Toast com resultado: "31 boletins criados, R$ 527.124,19"

---

## 3. Preview da NFS-e antes de emitir
**Prioridade**: 🔴 Alta

**Hoje**: só via script Node `/tmp/preview-nfse.js`.

**Precisa**:
- Botão "👁️ Preview NFS-e" no painel ao lado de "Emitir"
- Modal mostra: pendências (lista vermelha), CNPJ resolvido, valor, ISS, discriminação, payload JSON
- Endpoint `/api/boletins/:id/preview-nfse` já existe

---

## 4. Reverter aprovação / emissão
**Prioridade**: 🟡 Média

**Hoje**: existe botão "↩️ Reabrir" mas não testado com NF emitida.

**Precisa**:
- Documentar fluxo: o que acontece com a NFS-e no WebISS quando reverte?
- Implementar cancelamento via WebISS se aplicável
- Histórico: registrar reversão como evento em audit log

---

## 5. Validações proativas no painel
**Prioridade**: 🔴 Alta

**Hoje**: banner amarelo só avisa CNPJ tomador faltando.

**Precisa**:
- Cada linha de boletim com ícone de status (🟢/🟡/🔴) clicável
- 🔴 = pendência crítica (sem CNPJ, valor zero, etc)
- 🟡 = aviso (certificado expira em <30 dias, alíquota divergente)
- 🟢 = pronto para emitir
- Tooltip ao passar o mouse mostra a pendência específica

---

## 6. Edição de glosas / acréscimos
**Prioridade**: 🟡 Média

**Hoje**: campos `glosas` e `acrescimos` existem mas UX desconhecida pelo operador.

**Precisa**:
- Botão "✏️ Ajustar" abrindo modal:
  - Valor base do posto: R$ X
  - Glosa: R$ ___ (motivo obrigatório)
  - Acréscimo: R$ ___ (motivo obrigatório)
  - Valor final: R$ X - glosa + acréscimo
- Histórico de glosas exibido abaixo

---

## 7. Logs de auditoria visíveis
**Prioridade**: 🟡 Média

**Hoje**: tabela `auditLog` registra mas não exibe na UI.

**Precisa**:
- Aba "Histórico" no detalhe do boletim
- Linhas: criado em, alteração de valor (com diff), aprovado por X em Y, emitido por X em Y
- Filtro por usuário e período

---

## 8. Permissões / RBAC
**Prioridade**: 🟢 Baixa

**Hoje**: só "admin" e "usuário".

**Precisa**: papéis específicos:
- **Operador**: cria/edita rascunho
- **Aprovador**: aprova boletim
- **Fiscal**: emite NFS-e
- **Auditor**: só leitura

Mapear permissões por endpoint.

---

## 9. Tratamento de erro do WebISS
**Prioridade**: 🟡 Média

**Hoje**: erro técnico exposto cru. Ex: "AESI001: prestador inválido".

**Precisa**:
- Dicionário de tradução: erro técnico → linguagem de operador + sugestão
- Botão "Tentar novamente" após correção
- Log do erro com timestamp para suporte

---

## 10. Treinamento e documentação
**Prioridade**: 🟢 Baixa

**Hoje**: zero documentação para operadores.

**Precisa**:
- Manual passo-a-passo (PDF ou wiki interna)
- Vídeo de 5-10min mostrando workflow Detran completo
- FAQ para erros comuns

---

## 11. Backup / restore acessível
**Prioridade**: 🟢 Baixa

**Hoje**: backup via branch Git (técnico).

**Precisa**:
- Botão "📥 Exportar boletins do mês" → ZIP com PDFs + Excel
- Para recuperação manual se algo for emitido errado
- Botão "🔄 Restaurar mês anterior" para clone (já existe `/_clonar-competencia`)

---

## 12. Sandbox para treinamento
**Prioridade**: 🟢 Baixa

**Hoje**: só ambiente de produção.

**Precisa**:
- Empresa-teste (`assessoria-teste`) ou modo "dry-run" global
- Bloqueia emissão real para o WebISS, mas simula UI completa
- Reset diário automático do schema-teste

---

## Ordem sugerida de implementação

1. **#2 — Botão Gerar boletins por posto** (próxima sprint)
2. **#3 — Preview NFS-e na UI** (próxima sprint)
3. **#5 — Validações no painel** (próxima sprint)
4. #1 — Cadastro de postos/itens via UI
5. #6 — Edição de glosas
6. #7 — Logs de auditoria
7. #9 — Tradução de erros WebISS
8. #4 — Reverter emissão (depende de WebISS API)
9. #10, #11, #12 — Polimento
10. #8 — RBAC (depende de SSO/governança)
