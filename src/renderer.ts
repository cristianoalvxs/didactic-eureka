import './style.css';

type Mode = 'grid' | 'focus';
type Settings = { gameUrl: string; enabled: boolean[]; mode: Mode; activeSlot: number; economyMode: boolean };
type Status = 'idle' | 'loading' | 'ready' | string;

declare global {
  interface Window {
    pokeManager: {
      getState: () => Promise<Settings>;
      saveSettings: (settings: Partial<Settings>) => Promise<Settings>;
      setLayout: (layout: { mode: Mode; activeSlot: number; width: number; height: number; headerHeight: number }) => Promise<void>;
      reloadSlot: (slot: number) => Promise<void>;
      openSlot: (slot: number) => Promise<void>;
      getMemoryUsage: () => Promise<Array<number | null>>;
      toggleFullScreen: () => Promise<boolean>;
      onFullScreenChange: (callback: (isFullScreen: boolean) => void) => () => void;
      onSlotStatus: (callback: (payload: { slot: number; status: string }) => void) => () => void;
    };
  }
}

const labels = ['Conta 01', 'Conta 02', 'Conta 03', 'Conta 04'];
const state: { settings: Settings; statuses: Status[]; notice: string; headerCollapsed: boolean; isFullScreen: boolean; memoryMb: Array<number | null> } = {
  settings: { gameUrl: '', enabled: [true, true, true, true], mode: 'grid', activeSlot: 0, economyMode: false },
  statuses: ['idle', 'idle', 'idle', 'idle'],
  notice: '',
  headerCollapsed: false,
  isFullScreen: false,
  memoryMb: [null, null, null, null],
};
const root = document.querySelector<HTMLDivElement>('#app')!;

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return 'Endereco do jogo'; }
}

function statusLabel(slot: number): string {
  if (!state.settings.enabled[slot]) return 'Oculta';
  if (!state.settings.gameUrl) return 'Sem endereco';
  if (state.statuses[slot] === 'loading') return 'Carregando';
  if (typeof state.statuses[slot] === 'string' && state.statuses[slot].startsWith('error:')) return 'Falha ao abrir';
  const memory = state.memoryMb[slot];
  const base = state.statuses[slot] === 'ready' ? 'Conectada' : 'Pronta';
  return memory ? `${base} \u00b7 ~${memory} MB` : base;
}

function render(): void {
  const { settings } = state;
  const headerHeight = state.headerCollapsed ? 86 : 176;
  root.classList.toggle('compact-header', state.headerCollapsed);
  root.style.setProperty('--header-height', `${headerHeight}px`);
  root.innerHTML = `
    <header class="topbar ${state.headerCollapsed ? 'compact' : ''}">
      <div class="brandline">
        <div class="brandmark" aria-hidden="true">P<span>.</span></div>
        <div class="brandcopy"><strong>POKEIDLE <span>MANAGER</span></strong><small>SESSOES DE JOGO</small></div>
        <div class="top-actions">
          <div class="mode-switch" role="group" aria-label="Modo de visualizacao">
            <button type="button" data-mode="grid" class="mode-button ${settings.mode === 'grid' ? 'selected' : ''}" aria-pressed="${settings.mode === 'grid'}"><span class="grid-glyph" aria-hidden="true">&#9638;</span> Grade</button>
            <button type="button" data-mode="focus" class="mode-button ${settings.mode === 'focus' ? 'selected' : ''}" aria-pressed="${settings.mode === 'focus'}"><span class="focus-glyph" aria-hidden="true">&#9633;</span> Foco</button>
          </div>
          <span class="limit-label"><i></i> LIMITE 4 CONTAS</span>
          <button type="button" class="window-button ${settings.economyMode ? 'active' : ''}" data-economy title="${settings.economyMode ? 'Economia ligada: contas ocultas no modo Foco avancam mais devagar para reduzir calor' : 'Economia desligada (recomendado p/ idle): todas as contas continuam progredindo em tempo real, mesmo ocultas ou minimizadas'}" aria-pressed="${settings.economyMode}">&#9889;</button>
          <button type="button" class="window-button ${state.isFullScreen ? 'active' : ''}" data-fullscreen title="${state.isFullScreen ? 'Sair da tela cheia' : 'Tela cheia'}" aria-label="${state.isFullScreen ? 'Sair da tela cheia' : 'Entrar em tela cheia'}"><span class="fullscreen-glyph" aria-hidden="true"></span></button>
          <button type="button" class="window-button collapse-button" data-collapse title="${state.headerCollapsed ? 'Expandir cabeçalho' : 'Recolher cabeçalho'}" aria-label="${state.headerCollapsed ? 'Expandir cabeçalho' : 'Recolher cabeçalho'}"><span aria-hidden="true">${state.headerCollapsed ? '&#9662;' : '&#9652;'}</span></button>
        </div>
      </div>
      <div class="account-strip">
        ${labels.map((label, slot) => `
          <div class="account-item ${settings.activeSlot === slot ? 'active' : ''} ${settings.enabled[slot] ? '' : 'disabled'}">
            <button class="account-select" type="button" data-select="${slot}" aria-pressed="${settings.activeSlot === slot}">
              <span class="account-number">0${slot + 1}</span>
              <span class="account-info"><strong>${label}</strong><small><i class="status-dot ${statusClass(slot)}"></i>${statusLabel(slot)}</small></span>
            </button>
            <button class="account-toggle" type="button" data-toggle="${slot}" aria-label="${settings.enabled[slot] ? 'Ocultar' : 'Mostrar'} ${label}" aria-pressed="${settings.enabled[slot]}">${settings.enabled[slot] ? '&#10003;' : '+'}</button>
          </div>`).join('')}
      </div>
      <form class="url-form" id="url-form">
        <label class="url-label" for="game-url"><span class="connection-dot"></span> JOGO</label>
        <input id="game-url" name="gameUrl" type="url" placeholder="https://endereco-do-jogo.com" value="${escapeHtml(settings.gameUrl)}" spellcheck="false" autocomplete="url" />
        <span class="url-host">${settings.gameUrl ? escapeHtml(safeHost(settings.gameUrl)) : 'Configure o endereco para iniciar'}</span>
        <button class="launch-button" type="submit">${settings.gameUrl ? 'Aplicar' : 'Conectar'} <span aria-hidden="true">&#8594;</span></button>
        ${settings.gameUrl ? `<button class="icon-button reload-button" type="button" data-reload title="Recarregar conta selecionada" aria-label="Recarregar conta selecionada">&#8635;</button>` : ''}
      </form>
      ${state.notice ? `<div class="notice" role="status">${escapeHtml(state.notice)}</div>` : ''}
    </header>
    <main class="stage ${settings.gameUrl ? 'has-game' : 'empty-stage'}">
      ${settings.gameUrl ? '' : `<section class="welcome"><div class="welcome-orbit" aria-hidden="true"><span></span><b></b></div><div class="welcome-copy"><p class="eyebrow">PRONTO PARA COMECAR</p><h1>Quatro perfis.<br><em>Seu proprio ritmo.</em></h1><p>Informe o endereco do jogo acima. Cada conta abre em um perfil isolado e mantem seu proprio login.</p><button type="button" class="welcome-action" data-focus-url>Configurar endereco <span aria-hidden="true">&#8593;</span></button></div><div class="welcome-foot"><span>01 / 04</span><span>SESSOES INDEPENDENTES</span></div></section>`}
      <div class="stage-caption ${settings.gameUrl ? '' : 'hidden'}"><span>${settings.mode === 'grid' ? 'VISAO GERAL' : `EM FOCO / 0${settings.activeSlot + 1}`}</span><span>${settings.gameUrl ? escapeHtml(safeHost(settings.gameUrl)) : ''}</span></div>
      <div class="disclaimer">App independente, sem afiliacao com o jogo. A atividade em segundo plano depende das regras e do servidor do proprio jogo.</div>
    </main>
  `;
  bindEvents();
  void sendLayout();
}

function statusClass(slot: number): string {
  if (!state.settings.enabled[slot]) return 'off';
  if (state.statuses[slot] === 'loading') return 'working';
  if (typeof state.statuses[slot] === 'string' && state.statuses[slot].startsWith('error:')) return 'error';
  return state.statuses[slot] === 'ready' ? 'online' : 'idle';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function bindEvents(): void {
  root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => {
    button.addEventListener('click', () => {
      state.settings.mode = button.dataset.mode as Mode;
      void saveCurrent();
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-select]').forEach(button => {
    button.addEventListener('click', () => {
      state.settings.activeSlot = Number(button.dataset.select);
      void saveCurrent();
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach(button => {
    button.addEventListener('click', () => {
      const slot = Number(button.dataset.toggle);
      state.settings.enabled[slot] = !state.settings.enabled[slot];
      void saveCurrent();
    });
  });
  root.querySelector<HTMLButtonElement>('[data-collapse]')?.addEventListener('click', () => {
    state.headerCollapsed = !state.headerCollapsed;
    render();
  });
  root.querySelector<HTMLButtonElement>('[data-economy]')?.addEventListener('click', () => {
    state.settings.economyMode = !state.settings.economyMode;
    void saveCurrent();
  });
  root.querySelector<HTMLButtonElement>('[data-fullscreen]')?.addEventListener('click', () => {
    void window.pokeManager.toggleFullScreen();
  });
  root.querySelector<HTMLFormElement>('#url-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const input = root.querySelector<HTMLInputElement>('#game-url')!;
    try {
      state.notice = '';
      state.settings.gameUrl = input.value.trim();
      await saveCurrent();
      state.notice = state.settings.gameUrl ? 'Endereco aplicado. Cada conta pode exigir um login separado.' : 'Endereco removido.';
      render();
    } catch (error) {
      state.notice = error instanceof Error ? error.message : 'Nao foi possivel salvar o endereco.';
      render();
    }
  });
  root.querySelector<HTMLButtonElement>('[data-reload]')?.addEventListener('click', () => {
    void window.pokeManager.reloadSlot(state.settings.activeSlot);
  });
  root.querySelector<HTMLButtonElement>('[data-focus-url]')?.addEventListener('click', () => {
    root.querySelector<HTMLInputElement>('#game-url')?.focus();
  });
}

async function saveCurrent(): Promise<void> {
  state.settings = await window.pokeManager.saveSettings(state.settings);
  render();
}

async function sendLayout(): Promise<void> {
  await window.pokeManager.setLayout({
    mode: state.settings.mode,
    activeSlot: state.settings.activeSlot,
    width: window.innerWidth,
    height: window.innerHeight,
    headerHeight: state.headerCollapsed ? 86 : 176,
  });
}

window.pokeManager.onSlotStatus(({ slot, status }) => {
  state.statuses[slot] = status;
  render();
});

window.addEventListener('resize', () => void sendLayout());
window.pokeManager.onFullScreenChange(isFullScreen => {
  state.isFullScreen = isFullScreen;
  render();
});

setInterval(() => {
  void window.pokeManager.getMemoryUsage().then(usage => {
    state.memoryMb = usage;
    render();
  });
}, 5000);

void window.pokeManager.getState().then(saved => {
  state.settings = saved;
  render();
});
