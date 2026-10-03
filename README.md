# PokeIdle Manager

Aplicativo desktop independente para abrir ate quatro perfis do jogo, cada um com cookies e armazenamento isolados. O cliente escolhe entre **Grade** (quatro janelas visiveis) e **Foco** (uma janela grande com troca entre contas). Alterar o modo nao encerra as outras sessoes.

O aplicativo nao automatiza jogabilidade, nao coleta credenciais e nao altera o servidor do jogo. A opcao de segundo plano desativa o throttling de paginas do Chromium quando suportado; o jogo pode continuar pausando contas por regra propria, e o macOS pode suspender atividade quando o computador entra em repouso. Verifique os termos do jogo antes de distribuir ou usar o aplicativo. Este projeto nao e afiliado ao jogo nem aos titulares de suas marcas.

## Requisitos

- macOS 12 ou posterior para desenvolvimento e empacotamento
- Node.js 20 ou posterior e npm

## Desenvolvimento

```sh
npm install
npm run dev
```

Digite o endereco HTTPS ou HTTP do jogo no campo superior. Cada perfil abre esse endereco num armazenamento persistente separado; autentique cada conta diretamente no site. O botao ao lado do endereco ativa ou desativa cada perfil. A opcao de Grade mostra os perfis em uma matriz 2x2; Foco amplia o perfil selecionado. Os dados de login ficam no diretorio de dados de usuario do Electron e nao sao salvos neste projeto.

## Distribuicao para macOS

```sh
npm run package:mac
```

O Electron Builder gera imagens DMG para Apple Silicon e Intel na pasta `release/`. A distribuicao publica requer assinatura de codigo e notarizacao com credenciais de desenvolvedor Apple; este projeto nao inclui certificados. Sem assinatura/notarizacao, o macOS pode exibir avisos do Gatekeeper.

## Backend de licencas e assinaturas

O servico inicial fica em [`backend/`](backend/README.md). Ele fornece cadastro/login, entitlement gratuito de uma sessao, entitlement Pro de quatro sessoes, checkout recorrente Mercado Pago e endpoints de verificacao Apple StoreKit/App Store Server Notifications V2. Para iniciar localmente: `cp backend/.env.example backend/.env`, defina `JWT_SECRET` e rode `npm --prefix backend install`, `npm --prefix backend run typecheck`, `npm --prefix backend test` e `npm --prefix backend run dev`.

Esta e a fundacao do backend, nao um fluxo de cobranca pronto para producao. O cliente Electron ainda precisa de tela de conta/checkout e de aplicar `maxSlots` no processo principal; o checkout so libera Pro depois da confirmacao assinada do provedor. Credenciais de producao, HTTPS e banco persistente precisam ser configurados no host de deploy. Para App Store, sera necessario um cliente que integre StoreKit e revisar a elegibilidade do app com a Apple; ver [`backend/README.md`](backend/README.md).

## Observacoes

- Ate quatro perfis locais podem ser abertos. O aplicativo nao valida nem altera o limite imposto pelo jogo.
- As quatro particoes de navegador persistem entre execucoes. Remover dados do aplicativo pode apagar sessoes salvas.
- O jogo e carregado diretamente pelo cliente, sujeito ao site, a sua disponibilidade e aos seus termos de uso.
