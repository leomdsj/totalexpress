/**
 * patch-audio.js - restaura o sinal sonoro da bipagem (Total Express / ICS)
 *
 * PROBLEMA (medido, nao inferido):
 *   - agentes/caf_reg_do.php linhas 177-190: playTemEncomendas e playUltimaEncomenda
 *     sao declaradas com "var" DENTRO do callback de jN(document).ready(), ficam presas
 *     na closure, e NENHUM ponto do sistema as chama. Verificado nos 71 scripts
 *     carregados + o HTML da pagina: os unicos .play() sao esses dois, orfaos.
 *   - agentes/caf_view.php, onde a bipagem repetida realmente acontece, nao tem
 *     codigo de audio nenhum.
 *   - /audio/som-erro.wav e /audio/som-sucesso.wav respondem 200/206 e tocam
 *     normalmente. O audio nunca foi o problema.
 *
 * COMO ESTE PATCH DECIDE O QUE TOCAR:
 *   ERRO    -> engancha window.alert. Todo caminho de erro da bipagem termina num
 *              alert(): o do AJAX (ajax_validar_rota_awb.php com sucesso:false) e o
 *              que o servidor injeta no topo da resposta do POST de caf_reg_do.php.
 *              Enganchar o alert cobre todos de uma vez, sem mapear caso a caso.
 *              O som de erro e gerado em memoria, igual ao do app desktop (ERRO_TONS).
 *   SUCESSO -> compara o contador de encomendas da CAF com o valor guardado em
 *              sessionStorage. Erro nunca incrementa o contador, entao ele so sobe
 *              quando a encomenda entrou de verdade. Sobrevive ao reload de pagina.
 *
 * INSTALACAO: incluir nas DUAS telas, o mais cedo possivel dentro do <head>:
 *     <script src="/js/patch-audio.js"></script>
 *   em agentes/caf_reg_do.php e agentes/caf_view.php.
 *   E apagar o bloco morto de caf_reg_do.php linhas 177-190.
 *
 * VERIFICACAO: abra a tela de bipagem e rode __beepAutoteste() no console.
 */
(function () {
    'use strict';

    // Suba a cada mudanca: e o que diz, no registro do PDA, qual patch esta rodando.
    var VERSAO = '2026-09-22.1';
    var PREFIXO = '[beep]';

    function log() {
        // A falha original era silenciosa. Aqui nada falha calado.
        try { console.warn.apply(console, [PREFIXO].concat(Array.prototype.slice.call(arguments))); }
        catch (e) {}
    }

    function ativacao() {
        var u = navigator.userActivation;
        return u ? 'ativo=' + u.isActive + ' jaAtivo=' + u.hasBeenActive : 'n/d';
    }

    // Log incondicional, ANTES do filtro de tela: se o patch nunca aparecer no
    // registro do app, isto aqui e o unico jeito de saber se o script rodou e
    // em que pathname caiu, em vez de silencio total sem pista nenhuma.
    log('patch v' + VERSAO + ' carregado, pathname=' + location.pathname +
        ' readyState=' + document.readyState);

    // So as telas de bipagem. O manifest da extensao usa um padrao largo de propósito:
    // padrao de URL do Chrome tem pegadinha com query string, e o gancho no alert
    // precisa ser instalado em document_start, quando ainda nao existe DOM para
    // inspecionar. Decidir aqui pelo pathname e mais preciso e mais facil de testar.
    var TELAS = /\/agentes\/(caf_reg_do|caf_view)\.php$/;
    if (!TELAS.test(location.pathname)) {
        log('tela fora do padrao esperado: gancho de som NAO instalado nesta pagina');
        return;
    }

    // Erro = o mesmo som do app desktop, que o operador ja conhece (Python _gerar_wav):
    // PCM 16-bit mono 44100 Hz, senoide pura, amplitude maxima fixa, sem envelope.
    // [Hz, ms], Hz 0 = silencio. Gerado aqui, nao depende do /audio/som-erro.wav do ICS.
    var ERRO_TONS = [[400, 120], [0, 70], [400, 120], [0, 70], [400, 120], [0, 70], [220, 650]];

    function gerarWav(tons) {
        var TAXA = 44100, amostras = [];
        tons.forEach(function (t) {
            var n = Math.floor(TAXA * t[1] / 1000);
            for (var i = 0; i < n; i++) {
                amostras.push(t[0] ? Math.round(32767 * Math.sin(2 * Math.PI * t[0] * i / TAXA)) : 0);
            }
        });
        var buf = new ArrayBuffer(44 + amostras.length * 2), v = new DataView(buf);
        function txt(o, s) { for (var i = 0; i < s.length; i++) { v.setUint8(o + i, s.charCodeAt(i)); } }
        txt(0, 'RIFF'); v.setUint32(4, 36 + amostras.length * 2, true); txt(8, 'WAVE');
        txt(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, TAXA, true); v.setUint32(28, TAXA * 2, true);
        v.setUint16(32, 2, true); v.setUint16(34, 16, true);
        txt(36, 'data'); v.setUint32(40, amostras.length * 2, true);
        amostras.forEach(function (a, i) { v.setInt16(44 + i * 2, a, true); });
        return buf;
    }

    var SONS = {
        sucesso: '/audio/som-sucesso.wav',
        erro: URL.createObjectURL(new Blob([gerarWav(ERRO_TONS)], { type: 'audio/wav' }))
    };
    var TOM = { sucesso: 880, erro: 220 };   // Hz do fallback sintetizado
    var cache = {};
    var ctxAudio = null;

    // Fallback: se o .wav sumir do servidor, sintetiza o bip na Web Audio API.
    function oscilador(tipo) {
        try {
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) { log('sem Web Audio API: impossivel emitir som'); return; }
            if (!ctxAudio || ctxAudio.state === 'closed') { ctxAudio = new AC(); }
            if (ctxAudio.state === 'suspended') { ctxAudio.resume(); }
            var osc = ctxAudio.createOscillator();
            var vol = ctxAudio.createGain();
            osc.type = 'square';
            osc.frequency.value = TOM[tipo];
            vol.gain.value = 0.15;
            osc.connect(vol);
            vol.connect(ctxAudio.destination);
            osc.start();
            osc.stop(ctxAudio.currentTime + (tipo === 'erro' ? 0.35 : 0.18));
            log('fallback sintetizado usado para "' + tipo + '"');
        } catch (e) {
            log('fallback do oscilador tambem falhou:', e && e.message);
        }
    }

    function tocar(tipo) {
        var el = cache[tipo];
        if (!el) {
            el = cache[tipo] = new Audio(SONS[tipo]);
            el.preload = 'auto';
            el.addEventListener('error', function () {
                var cod = el.error ? el.error.code : '?';
                log('arquivo ' + SONS[tipo] + ' nao carregou (MediaError ' + cod + ')');
            });
        }
        try { el.currentTime = 0; } catch (e) {}
        log('tocar ' + tipo + ': readyState=' + el.readyState + ' muted=' + el.muted +
            ' volume=' + el.volume + ' ' + ativacao());

        var p;
        try {
            p = el.play();
        } catch (e) {
            log('play() lancou excecao:', e && e.message);
            return oscilador(tipo);
        }
        // O codigo original chamava snd.play() sem .catch(): qualquer rejeicao sumia.
        if (p && typeof p.then === 'function') {
            p.then(function () { log('play() OK: ' + tipo); }, function (e) {
                log('play() REJEITADO (' + e.name + ': ' + e.message + ') para ' + SONS[tipo]);
                if (e.name === 'NotAllowedError') {
                    log('bloqueio de autoplay: o som sai no proximo bipe, ja com gesto do operador');
                }
                oscilador(tipo);
            });
        }
    }

    // Destrava o autoplay no primeiro gesto do operador. Depois do reload de pagina a
    // ativacao do usuario zera e o Chrome pode recusar o play(). Um toque mudo no
    // primeiro keydown/click deixa o elemento liberado para os bipes seguintes.
    function destravar(ev) {
        log('destravando audio no primeiro gesto (' + (ev && ev.type) + ')');
        Object.keys(SONS).forEach(function (tipo) {
            try {
                var el = cache[tipo] || (cache[tipo] = new Audio(SONS[tipo]));
                // Bipe rapido logo apos o sucesso: sem isto o toque mudo cortava o som em curso.
                // Causa medida do relato "erro toca, sucesso nao": destravar mutava e depois
                // pausava/zerava o MESMO elemento que tocar('sucesso') tinha acabado de iniciar.
                if (!el.paused) { log('destravar: ' + tipo + ' ja esta tocando, pulei (nao cortei o som)'); return; }
                el.muted = true;
                var p = el.play();
                if (p && p.then) {
                    p.then(function () { el.pause(); el.currentTime = 0; el.muted = false; },
                        function () { el.muted = false; });
                }
            } catch (e) {}
        });
        if (ctxAudio && ctxAudio.state === 'suspended') { ctxAudio.resume(); }
        document.removeEventListener('keydown', destravar, true);
        document.removeEventListener('click', destravar, true);
    }

    // Contador de encomendas da CAF. Sobe so quando a encomenda entrou de verdade.
    function contador() {
        var total = 0, achou = false;
        ['num_enc_i', 'num_enc_r'].forEach(function (id) {          // caf_view.php
            var el = document.getElementById(id);
            if (el) { total += Number(el.value) || 0; achou = true; }
        });
        if (!achou) {                                                // caf_reg_do.php
            var el2 = document.querySelector('input[name="num_encomendas_scan"]');
            if (el2) { total = Number(el2.value) || 0; achou = true; }
        }
        return achou ? total : null;
    }

    function chaveCaf() {
        var el = document.getElementById('cafid') || document.querySelector('input[name="cafid"]');
        return 'beep:contador:' + (el ? el.value : 'sem-caf');
    }

    function conferirSucesso() {
        var atual = contador();
        if (atual === null) {
            log('contador de encomendas nao encontrado nesta tela: sucesso nao detectavel');
            return;
        }
        var chave = chaveCaf();
        var anterior = null;
        try { anterior = sessionStorage.getItem(chave); } catch (e) {}
        try { sessionStorage.setItem(chave, String(atual)); } catch (e) { log('sessionStorage indisponivel:', e && e.message); }

        var sobe = anterior !== null && atual > Number(anterior);
        log('sucesso? chave=' + chave + ' anterior=' + anterior + ' atual=' + atual +
            (sobe ? ' -> TOCA' : anterior === null ? ' -> primeira leitura desta CAF, sem som' : ' -> nao subiu, sem som'));
        if (sobe) tocar('sucesso');
    }

    window.addEventListener('error', function (e) {
        log('erro JS na pagina: ' + e.message + ' @ ' + e.filename + ':' + e.lineno);
    });

    // So o app do PDA tem a ponte (flutter_inappwebview). Na extensao, so registra.
    // APK antigo nao tem o handler "vibrar": a chamada fica sem resposta, o som toca igual.
    function vibrar() {
        var ponte = window.flutter_inappwebview;
        if (!ponte || typeof ponte.callHandler !== 'function') { log('sem ponte do app: nao vibra aqui'); return; }
        try {
            ponte.callHandler('vibrar').then(function (r) { log('vibrar: ' + r); },
                function (e) { log('vibrar falhou:', e && e.message); });
        } catch (e) { log('vibrar lancou excecao:', e && e.message); }
    }

    // ---- ERRO: todo caminho de erro da bipagem passa por aqui ----
    var alertOriginal = window.alert;
    window.alert = function (msg) {
        log('alert interceptado: ' + String(msg).slice(0, 160));
        try { tocar('erro'); } catch (e) { log('falha ao tocar erro:', e && e.message); }
        vibrar();
        return alertOriginal.apply(window, arguments);
    };

    // ---- ligacao ----
    document.addEventListener('keydown', destravar, true);
    document.addEventListener('click', destravar, true);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', conferirSucesso);
    } else {
        conferirSucesso();
    }

    log('gancho de alert instalado, contador inicial=' + contador() + ' ' + ativacao());

    // Autoteste manual: rode __beepAutoteste() no console da tela de bipagem.
    window.__beepAutoteste = function () {
        var r = {
            versao: VERSAO,
            contador: contador(),
            chave: chaveCaf(),
            alertEnganchado: window.alert !== alertOriginal
        };
        console.log(PREFIXO, 'estado:', r);
        console.log(PREFIXO, 'tocando sucesso...');
        tocar('sucesso');
        setTimeout(function () { console.log(PREFIXO, 'tocando erro...'); tocar('erro'); }, 1200);
        setTimeout(function () {
            console.log(PREFIXO, 'testando fallback sintetizado (ignora o .wav)...');
            oscilador('erro');
        }, 2400);
        return r;
    };
})();
