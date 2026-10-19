// 玩法优化01 插件（MOD）＝ 赠送 / 求购 + 我抢！（合并版）
// ─────────────────────────────────────────────────────────────────────────────
// 三个功能（休整期 PREP）：
//   ① 赠送：每回合一次，把「整备区 / 临时整备区」中的一件干员或道具赠送给指定队友；
//      队友可选择接收或拒绝；队友卡槽（整备区）已满时无法赠送；每回合限一次。
//   ② 求购：资金不够时，可以请队友代付购买自己商店里的某件商品；棋子进自己的手牌
//      （走自己的池子 / 合成 / 购买效果），队友只出钱。队友可拒绝；AI 队友资金够时自动代付。
//   ③ 我抢！（可开关）：休整期观战队友时，以本体商店原样 UI 显示队友的商店，可代买——
//      钱从你账户扣，商品进你的手牌。开关默认开启，状态记忆在本地（localStorage）。
//
// 我抢开关：
//   - 大厅「选择模拟协议」页 · 模拟方式卡片区下方有「我抢 · 观战代买」总开关卡片（对局内不设开关）；
//   - 状态记忆在本地（localStorage，默认开）；关闭后观战不再显示代买商店栏（赠送 / 求购不受影响）。
//
// 实现说明（务必先看）：
//   - 本插件只是客户端 UI + 网络层；真正的转账 / 购买由服务器完成（本项目对局状态由服务器权威模拟）。
//   - 赠送：g.gift / g.giftReply + m.giftOffer / m.giftResolved（server/match/player/gift.js）。
//   - 求购：g.buyReq / g.buyReqReply + m.buyReqOffer / m.buyReqResolved（server/match/player/buyreq.js）。
//   - 我抢：g.peerShop → 服务器推送 m.peerShop 商店快照；g.peerBuy 由服务器在买家身上执行完整
//     购买校验（资金 / 手牌 / 卡池），主人商店标记 sold（server/match/player/peershop.js）。
//   - 「前往查看」的观战目标由本体 game.js 同步到 store.ui.watching（playerId 或 null）；
//     插件监听它，进入观战即拉取商店快照，返回自己 / 开战即收起商店栏。
//   - 商店栏复用本体 public/js/ui/shopBar.js 的 ChessCard / ItemCard / SoldCard 组件。
//     卡片 priv 传 null：合成进度点 / 技能调配是主人的私有数据，服务器不下发，显示中性卡。
//   - 自选（DIY）干员是队友的个人库存，不对外出售。
//   - 启用 / 卸下由游戏本体的 MOD 管理负责：主页左下角「插件 MOD」面板；卸下后不渲染本插件的任何 UI。
//
// UI 说明：浮层渲染在应用 DOM 内，直接复用游戏本体的组件类（.btn / .modal / 主题变量），
// 字号与位置一律用游戏的 rem 标度（根字号随视口缩放），因此与本体 UI 同步缩放、风格一致。

import { useState, useEffect, useRef } from 'preact/hooks';
import { ChessCard, ItemCard, SoldCard } from '../js/ui/shopBar.js';
import { audio } from '../js/audio.js';

const QIANG_KEY = 'sp.mod.gift.qiang'; // 我抢开关的本地记忆（默认开）
const qiangPref = () => {
  try { return localStorage.getItem(QIANG_KEY) !== '0'; } catch { return true; }
};
const setQiangPref = (on) => {
  try { localStorage.setItem(QIANG_KEY, on ? '1' : '0'); } catch { /* ignore */ }
};
const QIANG_EVENT = 'sp.mod.gift.qiang'; // 我抢开关变化的跨组件广播（大厅卡片 ↔ 对局内开关实时同步）
/** Shared 我抢 switch: module-level pub/sub so the lobby card and the in-game bar always agree. */
function useQiang() {
  const [qiang, setQiang] = useState(qiangPref());
  useEffect(() => {
    const sync = () => setQiang(qiangPref());
    window.addEventListener(QIANG_EVENT, sync);
    return () => window.removeEventListener(QIANG_EVENT, sync);
  }, []);
  /** Flip the switch, persist, broadcast. Returns the new value. */
  const toggleQiang = () => {
    const next = !qiangPref();
    setQiangPref(next);
    window.dispatchEvent(new CustomEvent(QIANG_EVENT));
    return next;
  };
  return [qiang, toggleQiang];
}

export default {
  name: '玩法优化01',
  version: '1.5.2',
  author: 'mod',
  description: '休整期可将自己的干员或道具赠送给队友（对方可拒收，每回合一次）；资金不够时可请队友代付购买商店商品（棋子进自己的手牌，队友只出钱）；观战队友时可代买其商店商品（钱从你账户扣，商品进你的手牌）——我抢带开关，可随时启停。',
  setup(api) {
    const { store, net, data, html, toast, registerOverlay, registerLobbyEntry } = api;

    const nameOf = (kind, id) => {
      try {
        const rec = kind === 'item' ? data.lookup('items', id)
          : kind === 'token' ? data.lookup('tokens', id)
          : data.lookup('chess', id);
        return rec && rec.name ? rec.name : id;
      } catch { return id; }
    };
    const kindLabel = (kind) => (kind === 'chess' ? '干员' : kind === 'item' ? '道具' : kind === 'token' ? '召唤物' : kind);

    const snapshot = () => {
      const s = store.get();
      const me = s.me && s.me.playerId;
      const pub = s.match && s.match.public;
      const priv = s.match && s.match.private;
      const players = (pub && pub.players) || [];
      const peers = players.filter((p) => p.playerId && p.playerId !== me && p.alive)
        .map((p) => ({ playerId: p.playerId, name: p.name, isBot: !!p.isBot }));
      const hand = (priv && priv.hand) || [];
      const temp = (priv && priv.temp) || [];
      const pieces = [...hand, ...temp].filter(Boolean).map((p) => ({ ...p }));
      const shopSlots = ((priv && priv.shop && priv.shop.slots) || []).map((sl, idx) => (sl && !sl.sold ? { idx, ...sl } : null)).filter(Boolean);
      const handFree = hand.filter((x) => x == null).length;
      return {
        me, pub, priv, peers, pieces, shopSlots,
        phase: pub && pub.phase,
        round: pub && pub.round,
        inMatch: !!(pub && pub.phase && pub.phase !== 'LOBBY'),
        funds: (priv && priv.funds) || 0,
        handFree,
        giftsUsed: (priv && priv.giftsThisRound) || 0,
        buyReqPending: !!(priv && priv.buyReqPending),
        watching: (s.ui && s.ui.watching) || null,
      };
    };

    // ---- 主题令牌（与 game 本体 theme.css 同源；只读变量，不发明新颜色） ----
    const T = {
      line: 'var(--line-2)', mint: 'var(--mint-400)', mintDeep: 'var(--mint-500)',
      dim: 'var(--text-dim)', lo: 'var(--text-lo)', hi: 'var(--text-hi)', amber: 'var(--amber)',
      chipBg: 'rgba(10, 13, 12, .6)',
    };

    function AssistOverlay() {
      // ---- 赠送 / 求购 的状态 ----
      const [open, setOpen] = useState(false);
      const [mode, setMode] = useState('gift'); // 'gift' | 'buy'
      const [selPiece, setSelPiece] = useState(null);
      const [selSlot, setSelSlot] = useState(null);
      const [selPeer, setSelPeer] = useState(null);
      const [pending, setPending] = useState(null); // incoming gift offer
      const [pendingBuy, setPendingBuy] = useState(null); // incoming buy request
      // ---- 我抢（观战代买）的状态（开关为模块级共享，大厅卡片与这里实时同步） ----
      const [qiang] = useQiang();
      const [shop, setShop] = useState(null); // last m.peerShop snapshot
      const [armed, setArmed] = useState(null); // two-tap: armed card key
      const [busy, setBusy] = useState(false);
      const watchRef = useRef(null); // the peer whose shop we display (guards stale snapshots)
      const [, force] = useState(0);

      const s0 = snapshot();
      const watchPid = s0.watching; // 观战目标只来自本体「前往查看」（game.js 同步到 store.ui.watching）

      // re-render on any store change (watching / phase / funds / hand / peers / shop / round)
      useEffect(() => store.subscribe(() => force((n) => n + 1)), []);

      // server pushes: peer shop snapshot + gift / buyreq offers and resolutions
      useEffect(() => {
        const me = store.get().me && store.get().me.playerId;

        const onShop = (m) => {
          const w = watchRef.current;
          if (!w || m.from !== w) return;
          setShop(m);
        };
        const onOffer = (m) => {
          setPending({ from: m.from, fromName: m.fromName, uid: m.uid, kind: m.kind, id: m.id, name: m.name });
          toast(`收到 ${m.fromName} 的赠送：${m.name}`, 'info');
        };
        const onResolved = (m) => {
          if (m.from === me) {
            toast(m.accepted ? `队友已接收你的 ${m.name}` : `队友拒绝了你的 ${m.name}`, m.accepted ? 'success' : 'warn');
            setOpen(false); setSelPiece(null); setSelPeer(null);
          } else if (m.to === me) {
            toast(m.accepted ? `你已接收 ${m.name}` : `你拒绝了 ${m.name}`, m.accepted ? 'success' : 'warn');
            setPending(null);
          }
        };
        const onBuyReq = (m) => {
          setPendingBuy({ from: m.from, fromName: m.fromName, kind: m.kind, id: m.id, name: m.name, price: m.price });
          toast(`${m.fromName} 请求你代购：${m.name}`, 'info');
        };
        const onBuyResolved = (m) => {
          if (m.from === me) {
            toast(m.accepted ? `队友已为你代购 ${m.name}` : '队友拒绝了你的代购请求', m.accepted ? 'success' : 'warn');
            setOpen(false); setSelSlot(null); setSelPeer(null);
          } else if (m.to === me) {
            toast(m.accepted ? `你已为对方代购 ${m.name}` : `你拒绝了代购请求`, m.accepted ? 'success' : 'warn');
            setPendingBuy(null);
          }
        };
        net.on('m.peerShop', onShop);
        net.on('m.giftOffer', onOffer);
        net.on('m.giftResolved', onResolved);
        net.on('m.buyReqOffer', onBuyReq);
        net.on('m.buyReqResolved', onBuyResolved);
        return () => {
          net.off('m.peerShop', onShop);
          net.off('m.giftOffer', onOffer); net.off('m.giftResolved', onResolved);
          net.off('m.buyReqOffer', onBuyReq); net.off('m.buyReqResolved', onBuyResolved);
        };
      }, []);

      // a stale watching id from an earlier match must not leak into a new one
      useEffect(() => {
        if (!s0.inMatch && s0.watching) { store.patch('ui', { watching: null }); }
      }, [s0.inMatch]);

      // entering a watch (or the phase turning PREP) pulls a fresh snapshot; leaving it clears the bar
      useEffect(() => {
        watchRef.current = watchPid || null;
        setShop(null);
        setArmed(null);
        if (watchPid && s0.phase === 'PREP') {
          net.request('g.peerShop', { to: watchPid }).catch(() => {});
        }
      }, [watchPid, s0.phase === 'PREP']);

      // two-tap like the own shop: a tap outside a card disarms (Escape too)
      // （置于早退 return 之前，保证 hooks 顺序稳定）
      useEffect(() => {
        if (!armed) return undefined;
        const onDown = (e) => { if (e.target && e.target.closest && !e.target.closest('.scard')) setArmed(null); };
        const onKey = (e) => { if (e.key === 'Escape') setArmed(null); };
        window.addEventListener('pointerdown', onDown, true);
        window.addEventListener('keydown', onKey);
        return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey); };
      }, [armed]);

      // ---- 我抢 · 代买 ----
      const buy = async (idx) => {
        if (!watchPid) return;
        setArmed(null);
        setBusy(true);
        try {
          await net.request('g.peerBuy', { slot: idx, to: watchPid });
          toast('已购买队友商店的商品', 'success');
        } catch (e) {
          toast('购买失败：' + (e && e.message ? e.message : '未知错误'), 'error');
        } finally {
          setBusy(false);
          // 购买后拉一份新快照，把已售槽位刷掉
          if (watchRef.current) net.request('g.peerShop', { to: watchRef.current }).catch(() => {});
        }
      };

      // ---- 赠送 / 求购 · 发起 ----
      const switchMode = (m) => { setMode(m); setSelPiece(null); setSelSlot(null); setSelPeer(null); };

      const sendGift = async () => {
        if (!selPiece || !selPeer) return;
        try {
          await net.request('g.gift', { uid: selPiece.uid, to: selPeer.playerId });
          toast('已发送赠送请求，等待队友确认', 'info');
          setOpen(false); setSelPiece(null); setSelPeer(null);
        } catch (e) {
          toast('赠送失败：' + (e && e.message ? e.message : '未知错误'), 'error');
        }
      };
      const sendBuyReq = async () => {
        if (!selSlot || !selPeer) return;
        try {
          await net.request('g.buyReq', { slot: selSlot.idx, to: selPeer.playerId });
          toast(`已向 ${selPeer.name} 发送代购请求`, 'info');
          setOpen(false); setSelSlot(null); setSelPeer(null);
        } catch (e) {
          toast('代购请求失败：' + (e && e.message ? e.message : '未知错误'), 'error');
        }
      };

      const acceptGift = async () => { try { await net.request('g.giftReply', { accept: true }); } catch (e) { toast('接收失败：' + (e && e.message ? e.message : ''), 'error'); } };
      const rejectGift = async () => {
        try { await net.request('g.giftReply', { accept: false }); } catch (e) { /* ignore */ }
        setPending(null);
      };
      const acceptBuy = async () => { try { await net.request('g.buyReqReply', { accept: true }); } catch (e) { toast('代购失败：' + (e && e.message ? e.message : ''), 'error'); } };
      const rejectBuy = async () => {
        try { await net.request('g.buyReqReply', { accept: false }); } catch (e) { /* ignore */ }
        setPendingBuy(null);
      };

      const s = snapshot();
      if (!s.inMatch) return null; // 主页不渲染（启停由本体「插件 MOD」面板的 MOD 管理负责）

      const isPrep = s.phase === 'PREP';
      const canOpen = isPrep;
      const showBar = isPrep && !!watchPid && qiang; // 我抢开关关闭时不渲染代买商店栏

      // ---- 我抢 · 商店卡片交互 ----
      const peersOfShop = shop && s.peers.find((p) => p.playerId === shop.from);
      const shopName = shop ? (peersOfShop ? peersOfShop.name : shop.name) : null;

      /** The reason a card cannot be bought right now (mirrors the server's checks), null when it can. */
      const reasonOf = (sl) => {
        if (!sl) return null;
        if (data.lookup && sl.kind === 'chess') {
          const rec = data.lookup('chess', sl.id);
          if (rec && rec.isDiy) return '自选干员不对外出售';
        }
        if (s.handFree <= 0) return '整备区已满，无法购入';
        if (s.funds < sl.price) return '资金不足';
        return null;
      };
      const tapCard = (kind, idx, sl, reason) => {
        const key = `${kind}:${idx}:${sl.id}`;
        if (armed !== key) { setArmed(key); return; }
        if (reason || busy) { setArmed(null); return; }
        buy(idx);
      };

      const slots = (shop && shop.slots) || [];

      // ---- 选中态芯片：暗底 + 细边框，选中时薄荷色描边（游戏 is-active 的做法） ----
      const chip = (on) => ({
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.08rem',
        padding: '.08rem .1rem', marginBottom: '.06rem', cursor: 'pointer', fontSize: '.16rem',
        lineHeight: 1.35, border: `1px solid ${on ? T.mintDeep : T.line}`, background: T.chipBg,
        color: on ? T.hi : 'var(--text-md)', boxShadow: on ? 'inset 0 0 0 1px rgba(78, 216, 175, .35)' : 'none',
        textAlign: 'left', width: '100%',
      });
      const tag = {
        flex: 'none', fontSize: '.12rem', letterSpacing: '.04em', color: T.dim,
        border: `1px solid ${T.line}`, padding: '.01rem .06rem', whiteSpace: 'nowrap',
      };
      const colTitle = {
        margin: '0 0 .08rem', fontSize: '.12rem', letterSpacing: '.14em',
        color: T.dim, textTransform: 'uppercase',
      };
      const tabBtn = (on) => ({ flex: '1', textAlign: 'center' });
      const empty = { color: T.dim, fontSize: '.14rem', margin: '0' };

      return html`
        ${isPrep ? html`
          <div style=${{ position: 'fixed', left: '.24rem', bottom: '.9rem', zIndex: 50, display: 'flex', gap: '.06rem' }}>
            <button class="btn btn--sm"
                    onClick=${() => { audio.sfx('click', { volume: 0.4 }); setOpen(true); }}>
              <span class="btn__label" style=${{ color: T.mint }}>🎁 赠送 / 求购</span>
            </button>
          </div>` : null}

        ${showBar ? html`
          <section class=${`shopbar${shop ? '' : ' is-locked'}`}
                   style=${{ position: 'fixed', right: '.26rem', bottom: '.2rem', zIndex: 40 }}
                   aria-label="观战 · 队友商店">
            <div class="shopbar__tools">
              <span class="shopbar__remain" style=${{ pointerEvents: 'auto' }}>
                👁 ${shopName || '…'} 的商店${shop ? html` · LV <b class="num">${shop.level}</b>` : ''}
              </span>
            </div>
            <div class="shopbar__row">
              <div class="shopbar__cards">
                ${shop ? slots.map((sl, i) => (sl && sl.kind !== 'item' ? (sl.sold ? html`<${SoldCard} key=${`s${i}`} />` : (() => {
                  const reason = reasonOf(sl);
                  const key = `c:${i}:${sl.id}`;
                  return html`<${ChessCard} key=${key} slot=${sl} idx=${i} priv=${null} frozen=${sl.frozen}
                    reason=${reason} armed=${armed === key} onTap=${(idx) => tapCard('c', idx, sl, reason)}
                    onBuy=${() => {}} onDetail=${() => {}} />`;
                })()) : html`<${SoldCard} key=${`s${i}`} />`)) : null}
              </div>
              <div class="shopbar__item">
                ${shop ? (() => {
                  const items = slots.map((sl, i) => ({ sl, i })).filter(({ sl }) => sl && sl.kind === 'item');
                  if (!items.length) return html`<${SoldCard} item=${true} />`;
                  return items.map(({ sl, i }) => (sl.sold ? html`<${SoldCard} key=${`i${i}`} item=${true} />` : (() => {
                    const reason = reasonOf(sl);
                    const key = `i:${i}:${sl.id}`;
                    return html`<${ItemCard} key=${key} slot=${sl} idx=${i} frozen=${sl.frozen}
                      reason=${reason} armed=${armed === key} onTap=${(idx) => tapCard('i', idx, sl, reason)}
                      onBuy=${() => {}} onDetail=${() => {}} />`;
                  })()));
                })() : null}
              </div>
              <div class="funds">
                <div class="funds__hex"><b class="funds__num num">${s.funds}</b></div>
                <span class="funds__label">我的资金</span>
              </div>
            </div>
          </section>` : null}

        ${open ? html`
          <div class="modal" onClick=${() => { audio.sfx('back', { volume: 0.5 }); setOpen(false); }}>
            <div class="modal__box" style=${{ width: 'min(7.2rem, 94vw)' }} onClick=${(e) => e.stopPropagation()}>
              <div class="modal__stripe"></div>
              <div class="modal__head">
                <div class="modal__title">赠送 / 求购</div>
                <div style=${{ fontSize: '.13rem', color: T.dim }}>${
                  mode === 'gift'
                    ? '选择一件手牌与一位队友；对方确认后才会转移。'
                    : '选择商店中的一件商品与一位队友；对方代付后商品进入你的手牌。'
                }</div>
                <div style=${{ display: 'flex', gap: '.06rem', marginTop: '.08rem' }}>
                  <button class=${mode === 'gift' ? 'btn btn--sm is-active' : 'btn btn--sm'} style=${tabBtn(mode === 'gift')}
                          onClick=${() => { audio.sfx('tab', { volume: 0.5 }); switchMode('gift'); }}><span class="btn__label">赠送</span></button>
                  <button class=${mode === 'buy' ? 'btn btn--sm is-active' : 'btn btn--sm'} style=${tabBtn(mode === 'buy')}
                          onClick=${() => { audio.sfx('tab', { volume: 0.5 }); switchMode('buy'); }}><span class="btn__label">求购</span></button>
                </div>
              </div>
              <div class="modal__body">
                ${mode === 'gift' ? html`
                  <div style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.16rem' }}>
                    <div style=${{ minWidth: '0' }}>
                      <p style=${colTitle}>我的手牌 · 点击选择</p>
                      ${s.pieces.length === 0 ? html`<p style=${empty}>整备区为空，无可赠送的棋子。</p>` : null}
                      ${s.pieces.map((p) => html`
                        <button class=${selPiece && selPiece.uid === p.uid ? 'btn is-active' : 'btn'}
                                style=${chip(selPiece && selPiece.uid === p.uid)}
                                onClick=${() => { audio.sfx('tab', { volume: 0.4 }); setSelPiece(selPiece && selPiece.uid === p.uid ? null : p); }}>
                          <span style=${{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            ${nameOf(p.kind, p.id)}${p.golden ? ' ★' : ''}
                          </span>
                          <span style=${tag}>${kindLabel(p.kind)}${p.tier ? ' T' + p.tier : ''}</span>
                        </button>`)}
                    </div>
                    <div style=${{ minWidth: '0' }}>
                      <p style=${colTitle}>送给哪位队友</p>
                      ${s.peers.length === 0 ? html`<p style=${empty}>当前没有可赠送的队友。</p>` : null}
                      ${s.peers.map((p) => html`
                        <button class=${selPeer && selPeer.playerId === p.playerId ? 'btn is-active' : 'btn'}
                                style=${chip(selPeer && selPeer.playerId === p.playerId)}
                                onClick=${() => { audio.sfx('tab', { volume: 0.4 }); setSelPeer(selPeer && selPeer.playerId === p.playerId ? null : p); }}>
                          <span style=${{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${p.name}</span>
                          <span style=${tag}>${p.isBot ? 'AI · 自动接收' : '队友'}</span>
                        </button>`)}
                    </div>
                  </div>` : html`
                  <div style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.16rem' }}>
                    <div style=${{ minWidth: '0' }}>
                      <p style=${colTitle}>我的商店 · 选择要代购的商品</p>
                      ${s.shopSlots.length === 0 ? html`<p style=${empty}>商店中没有可购买的商品。</p>` : null}
                      ${s.shopSlots.map((sl) => {
                        const on = selSlot && selSlot.idx === sl.idx;
                        const afford = s.funds >= sl.price;
                        return html`
                          <button class=${on ? 'btn is-active' : 'btn'} style=${chip(on)}
                                  onClick=${() => { audio.sfx('tab', { volume: 0.4 }); setSelSlot(on ? null : sl); }}>
                            <span style=${{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              ${nameOf(sl.kind, sl.id)}${sl.frozen ? ' ❄' : ''}
                            </span>
                            <span style=${{ ...tag, ...(afford ? {} : { color: T.amber, borderColor: T.amber }) }}>
                              ${kindLabel(sl.kind)} · ${sl.price}
                            </span>
                          </button>`;
                      })}
                    </div>
                    <div style=${{ minWidth: '0' }}>
                      <p style=${colTitle}>请哪位队友代付</p>
                      ${s.peers.length === 0 ? html`<p style=${empty}>当前没有可求助的队友。</p>` : null}
                      ${s.peers.map((p) => html`
                        <button class=${selPeer && selPeer.playerId === p.playerId ? 'btn is-active' : 'btn'}
                                style=${chip(selPeer && selPeer.playerId === p.playerId)}
                                onClick=${() => { audio.sfx('tab', { volume: 0.4 }); setSelPeer(selPeer && selPeer.playerId === p.playerId ? null : p); }}>
                          <span style=${{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${p.name}</span>
                          <span style=${tag}>${p.isBot ? 'AI · 资金够即代付' : '队友'}</span>
                        </button>`)}
                    </div>
                  </div>`}
              </div>
              <div class="modal__actions">
                <span style=${{ marginRight: 'auto', fontSize: '.13rem', color: T.dim }}>${
                  mode === 'gift'
                    ? (s.giftsUsed >= 1 ? '本回合已赠送（1/1）' : '每回合限一次 · 仅休整期')
                    : (s.buyReqPending ? '等待队友处理你的代购请求…' : '代付后商品进入你的手牌 · 仅休整期')
                }</span>
                <button class="btn btn--sm" onClick=${() => { audio.sfx('back', { volume: 0.5 }); setOpen(false); }}>关闭</button>
                ${mode === 'gift'
                  ? html`<button class="btn btn--primary btn--sm" disabled=${!selPiece || !selPeer || s.giftsUsed >= 1} onClick=${() => { audio.sfx('confirm', { volume: 0.5 }); sendGift(); }}>确认赠送</button>`
                  : html`<button class="btn btn--primary btn--sm" disabled=${!selSlot || !selPeer || s.buyReqPending} onClick=${() => { audio.sfx('confirm', { volume: 0.5 }); sendBuyReq(); }}>请求代购</button>`}
              </div>
            </div>
          </div>` : null}

        ${pending ? html`
          <div class="modal">
            <div class="modal__box" style=${{ width: 'min(4.2rem, 92vw)' }}>
              <div class="modal__stripe"></div>
              <div class="modal__head">
                <div class="modal__title">收到一份赠送</div>
              </div>
              <div class="modal__body">
                <p class="modal__text" style=${{ margin: '0', textAlign: 'center' }}>
                  <b style=${{ color: T.hi }}>${pending.fromName}</b> 想赠送你<br/>
                  <b style=${{ color: T.mint }}>${pending.name}</b>
                  <span style=${{ color: T.dim }}>（${kindLabel(pending.kind)}）</span>
                </p>
              </div>
              <div class="modal__actions" style=${{ justifyContent: 'center' }}>
                <button class="btn btn--primary btn--sm" onClick=${() => { audio.sfx('confirm', { volume: 0.5 }); acceptGift(); }}>接收</button>
                <button class="btn btn--sm" onClick=${() => { audio.sfx('back', { volume: 0.5 }); rejectGift(); }}>拒绝</button>
              </div>
            </div>
          </div>` : null}

        ${pendingBuy ? html`
          <div class="modal">
            <div class="modal__box" style=${{ width: 'min(4.6rem, 92vw)' }}>
              <div class="modal__stripe"></div>
              <div class="modal__head">
                <div class="modal__title">代购请求</div>
              </div>
              <div class="modal__body">
                <p class="modal__text" style=${{ margin: '0', textAlign: 'center' }}>
                  <b style=${{ color: T.hi }}>${pendingBuy.fromName}</b> 资金不足，想请你代购<br/>
                  <b style=${{ color: T.mint }}>${pendingBuy.name}</b>
                  <span style=${{ color: T.dim }}>（${kindLabel(pendingBuy.kind)} · 价格 ${pendingBuy.price}）</span><br/>
                  <span style=${{ color: T.dim, fontSize: '.13rem' }}>商品将进入对方的手牌，由你支付费用。</span>
                </p>
              </div>
              <div class="modal__actions" style=${{ justifyContent: 'center' }}>
                <button class="btn btn--primary btn--sm" onClick=${() => { audio.sfx('confirm', { volume: 0.5 }); acceptBuy(); }}>代付 ${pendingBuy.price}</button>
                <button class="btn btn--sm" onClick=${() => { audio.sfx('back', { volume: 0.5 }); rejectBuy(); }}>拒绝</button>
              </div>
            </div>
          </div>` : null}
      `;
    }

    // ---- 大厅卡片：「选择模拟协议」页 · 模拟方式卡片区下方，我抢的总开关 ----
    function QiangLobbyCard() {
      const [qiang, toggleQiang] = useQiang();
      const display = 'var(--font-display)';
      return html`
        <div class="brackets" style=${{ '--bk-c': qiang ? 'var(--mint-400)' : 'var(--line-2)', display: 'flex', alignItems: 'center', gap: '.2rem',
          background: 'linear-gradient(180deg, rgba(28, 34, 31, .92), rgba(13, 16, 15, .94))',
          border: `1px solid ${qiang ? 'var(--mint-700)' : 'var(--line)'}`,
          boxShadow: qiang ? '0 0 0 1px rgba(78, 216, 175, .22), 0 0 .44rem rgba(23, 249, 183, .13), inset 0 0 .7rem rgba(23, 249, 183, .05)' : 'none',
          padding: '.18rem .32rem', flexWrap: 'wrap',
          transition: 'border-color var(--t-med), box-shadow var(--t-med)' }}>
          <span aria-hidden="true" style=${{ flex: 'none', width: '.56rem', height: '.56rem', display: 'grid', placeItems: 'center',
            background: qiang ? 'var(--mint-500)' : '#0c0f0e', border: `1px solid ${qiang ? 'var(--mint-400)' : 'var(--line-2)'}`,
            color: qiang ? 'var(--text-on-mint)' : 'var(--text-md)',
            clipPath: 'polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)' }}>
            <svg viewBox="0 0 24 24" style=${{ width: '.3rem', height: '.3rem' }} aria-hidden="true">
              <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" fill="none" stroke="currentColor" stroke-width="1.6" />
              <circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.4" />
            </svg>
          </span>
          <span style=${{ display: 'flex', flexDirection: 'column', gap: '.04rem', flex: '1 1 2.6rem', minWidth: '0' }}>
            <span style=${{ fontFamily: display, fontSize: '.1rem', letterSpacing: '.18em', color: qiang ? 'var(--mint-400)' : 'var(--text-dim)' }}>EYE-GRAB</span>
            <span style=${{ fontFamily: display, fontSize: '.19rem', fontWeight: 900, letterSpacing: '.06em', color: 'var(--text-hi)' }}>我抢 · 观战代买</span>
            <span style=${{ fontSize: '.11rem', lineHeight: 1.5, color: 'var(--text-dim)' }}>
              观战队友时可按本体商店原样代买其商品——钱从你的账户扣，商品进你的手牌。
            </span>
          </span>
          <button type="button" aria-pressed=${qiang ? 'true' : 'false'}
                  onClick=${() => { audio.sfx('tab', { volume: 0.4 }); const next = toggleQiang();
                    toast(next ? '我抢已开启：观战队友时可代买其商店商品' : '我抢已关闭：不再显示队友商店代买栏', next ? 'success' : 'info'); }}
                  style=${{ flex: 'none', cursor: 'pointer', borderRadius: '.08rem', padding: '.12rem .3rem',
                    fontFamily: display, fontSize: '.15rem', fontWeight: 700, letterSpacing: '.1em',
                    color: qiang ? 'var(--text-on-mint)' : 'var(--text-md)',
                    background: qiang ? 'var(--mint-500)' : 'rgba(255,255,255,.03)',
                    border: `1px solid ${qiang ? 'var(--mint-400)' : 'var(--line-2)'}`,
                    transition: 'background var(--t-med), border-color var(--t-med), color var(--t-med)' }}>
            ${qiang ? '👁 已开启' : '已关闭'}
          </button>
        </div>`;
    }

    registerLobbyEntry({ id: 'gift-qiang', Component: QiangLobbyCard });
    registerOverlay(AssistOverlay);
  },
};

// 稳定插件 id：文件名可以随便改（例如改成中文名方便辨认），本体的「启用 / 卸下」状态、设置行 / 按钮位归属、服务端 per-match 状态键都认这个 id。
export const id = 'gift';
