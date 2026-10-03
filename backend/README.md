# License API

Serviço Fastify/TypeScript para identidade, assinatura e entitlement do PokeIdle Manager. A regra central é calculada no servidor: conta sem assinatura ativa recebe `maxSlots: 1`; assinatura válida da Mercado Pago ou Apple recebe `maxSlots: 4`.

## Local

```sh
cp .env.example .env
```

Preencha `JWT_SECRET` com um segredo aleatório de pelo menos 32 bytes. Para testar autenticação e entitlements sem cobrar, não é necessário configurar Mercado Pago ou Apple.

```sh
npm install
npm run typecheck
npm test
npm run dev
```

O serviço escuta em `127.0.0.1:8787` por padrão e cria o SQLite em `backend/data/licenses.sqlite`. Use armazenamento persistente e backups no servidor de produção. SQLite é adequado para uma instância pequena e única; ao escalar horizontalmente, migre o store para PostgreSQL antes de executar múltiplas instâncias.

## API

- `POST /v1/auth/register` recebe `{ "email", "password" }`; cria a conta gratuita.
- `POST /v1/auth/login` retorna um JWT Bearer.
- `GET /v1/me` retorna perfil e entitlement atual.
- `POST /v1/billing/mercadopago/checkout` autenticado, recebe `{ "plan": "monthly" | "annual" }` e retorna uma URL hospedada de checkout.
- `POST /v1/webhooks/mercadopago` valida `x-signature` por HMAC e consulta a assinatura com a API Mercado Pago antes de mudar o entitlement.
- `POST /v1/apple/transaction` autenticado, recebe o JWS de transação assinado pelo StoreKit e valida-o com a biblioteca oficial da Apple.
- `POST /v1/webhooks/apple` valida notificações App Store Server Notifications V2 e sincroniza renovações, expirações e reembolsos.

As respostas de entitlement usam `tier: "free" | "pro"` e `maxSlots: 1 | 4`. O app cliente deve aplicar esse limite no processo principal antes de criar/mostrar sessões; a UI não é autoridade de licença. No fallback offline, mantenha apenas um slot permitido até o servidor confirmar a licença novamente.

## Mercado Pago

Crie uma aplicação em Suas integrações, use credenciais de teste durante desenvolvimento e configure no painel o webhook `subscription_preapproval` para `https://SEU_HOST/v1/webhooks/mercadopago`. Copie o segredo de assinatura para `MP_WEBHOOK_SECRET` e o access token apenas para o ambiente secreto do servidor. Configure `PUBLIC_BASE_URL`, preços e uma URL de retorno do seu domínio.

O redirect de retorno não libera Pro. Só o webhook autenticado seguido de consulta server-to-server à assinatura atualiza o banco. As chaves nunca devem estar no app Electron. Teste eventos de pagamento aprovado, renovação, pausa, cancelamento e estorno antes de produção.

## Apple

Configure uma assinatura auto-renovável e seus product IDs no App Store Connect; informe-os em `APPLE_MONTHLY_PRODUCT_IDS` e `APPLE_ANNUAL_PRODUCT_IDS`. Baixe os certificados raiz oficiais Apple PKI, guarde-os fora do repositório e liste seus caminhos em `APPLE_ROOT_CERT_PATHS`. Em produção configure bundle ID, Apple App ID numérico e URL V2 `https://SEU_HOST/v1/webhooks/apple` no App Store Connect.

O cliente nativo precisa comprar com StoreKit, definir o `appAccountToken` recebido no cadastro, enviar o JWS da transação para `/v1/apple/transaction` e observar atualizações/restore. O backend não aceita callbacks do cliente como prova de pagamento sem validar a assinatura JWS. Teste Sandbox antes de produção.

**Limite atual do cliente:** o aplicativo é Electron e ainda não integra StoreKit. A Mac App Store exige compra dentro do app para desbloquear recursos digitais em uma venda a consumidor e impõe requisitos de empacotamento/sandbox que este cliente Electron ainda não cumpre. Portanto, as rotas Apple são a fundação de servidor para um futuro cliente Mac App Store, não uma integração pronta para publicar esse Electron na loja. Solicite revisão da Apple para confirmar elegibilidade do produto antes de investir nessa distribuição.

## Segurança e privacidade

- TLS obrigatório em produção; limite de taxa na API e rotas de cadastro/login.
- Senhas são armazenadas como scrypt + salt; tokens JWT expiram em 14 dias.
- Webhooks são idempotentes e validados antes de atualizar entitlement.
- Não guarde senha do jogo, cookies do jogo ou dados de cartão neste backend.
- Defina política de privacidade, retenção/exclusão de contas, recuperação de senha e processo de suporte antes do beta pago.
- Não exponha o serviço local diretamente à internet. Faça deploy atrás de HTTPS, proteja segredos, habilite backups do banco e monitore falhas de webhook.
