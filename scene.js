/*
 * FitScene: the 3D layer behind the planner.
 *  - A dumbbell built from primitives. Its plates change with the chosen goal.
 *  - Three calorie columns (BMR, maintenance, target) that grow on the results page.
 *  - A drifting particle field. Drag the canvas to spin the dumbbell.
 *
 * Requires three.js r128 (global THREE). The scene is positioned by an
 * element with class "anchor": the 3D objects fit inside that rectangle.
 *
 * API: FitScene.init(canvas) -> boolean
 *      FitScene.setGoal('lose' | 'maintain' | 'gain')
 *      FitScene.showForm()
 *      FitScene.showResults({ bmr, tdee, target, goal })
 */
(function (global) {
    'use strict';

    var THREE = global.THREE;
    var api = {
        ok: false,
        init: function () {
            document.documentElement.classList.add('no-webgl');
            return false;
        },
        setGoal: function () {},
        showForm: function () {},
        showResults: function () {}
    };
    if (!THREE) { global.FitScene = api; return; }

    // ---------- Constants ----------
    var CAM_Z = 9;
    var TILT_X = -0.28;
    var TILT_Z = 0.16;
    var AUTO_SPIN = 0.32;            // radians per second
    var PLATE_T = 0.34;              // plate thickness
    var PLATE_STEP = 0.37;           // spacing between plates
    var PLATE_START = 1.3;           // where the first plate begins along the bar
    var COL_MAX = 2.2;               // tallest column, in world units
    var PLATE_SETS = {               // plate radii, inner to outer (0 = no plate)
        lose:     [0.62, 0.50, 0,    0],
        maintain: [0.86, 0.72, 0.58, 0],
        gain:     [1.15, 1.00, 0.86, 0.72]
    };

    var reduced = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var motion = reduced ? 0 : 1;

    // ---------- State ----------
    var started = false;
    var canvas, renderer, scene, camera;
    var dumbGroup, tilt, spin, handle, capL, capR;
    var plates = [];
    var cols = [];
    var colGroup, groundMat, ringMat;
    var particles, particleMat;
    var mats = {};
    var state = { mode: 'form', goal: 'lose', mix: 0, capX: 2.2, data: null };
    var drag = { on: false, lx: 0, ly: 0, vy: 0 };
    var pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    var lastTime = 0;

    // ---------- Helpers ----------
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function ease(dt, rate) { return reduced ? 1 : 1 - Math.exp(-dt * rate); }

    function cssColor(name, fallback) {
        try {
            var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
            return v || fallback;
        } catch (e) { return fallback; }
    }

    function isNarrow() { return global.innerWidth <= 860; }

    function pickAnchor() {
        var list = document.querySelectorAll('.anchor');
        for (var i = 0; i < list.length; i++) {
            if (list[i].getClientRects().length > 0) return list[i];
        }
        return null;
    }

    // ---------- Environment map (gives the metal something to reflect) ----------
    function buildEnvironment() {
        var pm = new THREE.PMREMGenerator(renderer);
        var envScene = new THREE.Scene();

        envScene.add(new THREE.Mesh(
            new THREE.SphereGeometry(20, 32, 16),
            new THREE.MeshBasicMaterial({ color: 0x0b0e1e, side: THREE.BackSide })
        ));

        function softbox(w, h, x, y, z, color, intensity) {
            var c = new THREE.Color(color);
            c.multiplyScalar(intensity);
            var m = new THREE.Mesh(
                new THREE.PlaneGeometry(w, h),
                new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide })
            );
            m.position.set(x, y, z);
            m.lookAt(0, 0, 0);
            envScene.add(m);
        }
        softbox(14, 4, 0, 10, 3, 0xffffff, 2.4);     // overhead
        softbox(3, 11, -10, 2, 4, 0x9fb8ff, 1.8);    // cool strip, left
        softbox(3, 11, 10, 1, -3, 0xff6a4a, 2.6);    // warm strip, right
        softbox(9, 3, 0, -5, -9, 0xffffff, 1.0);     // low back fill

        var texture = pm.fromScene(envScene, 0.03).texture;
        pm.dispose();
        return texture;
    }

    // ---------- Materials ----------
    function buildMaterials() {
        mats.steel = new THREE.MeshStandardMaterial({ color: 0xc6ccdc, metalness: 1, roughness: 0.28 });
        mats.dark = new THREE.MeshStandardMaterial({ color: 0x1a1e33, metalness: 0.8, roughness: 0.45 });
        mats.plate = new THREE.MeshStandardMaterial({
            color: 0x2a3050, metalness: 0.85, roughness: 0.38, side: THREE.DoubleSide
        });
        mats.accent = new THREE.MeshStandardMaterial({
            color: 0xff5a47, metalness: 0.3, roughness: 0.35, emissive: 0xff5a47, emissiveIntensity: 0.3
        });
        mats.colSteel = new THREE.MeshStandardMaterial({ color: 0xb9c0d4, metalness: 1, roughness: 0.3 });
        mats.colCool = new THREE.MeshStandardMaterial({
            color: 0x7fd6e8, metalness: 0.6, roughness: 0.3, emissive: 0x7fd6e8, emissiveIntensity: 0.18
        });
        mats.colAccent = new THREE.MeshStandardMaterial({
            color: 0xff5a47, metalness: 0.4, roughness: 0.3, emissive: 0xff5a47, emissiveIntensity: 0.3
        });
    }

    function applyTheme() {
        if (!started) return;
        var accent = cssColor('--accent', '#ff5a47');
        var cool = cssColor('--cool', '#7fd6e8');
        var steel = cssColor('--steel', '#b9c0d4');
        var particle = cssColor('--particle', '#9aa5d6');

        mats.accent.color.set(accent);
        mats.accent.emissive.set(accent);
        mats.colAccent.color.set(accent);
        mats.colAccent.emissive.set(accent);
        mats.colCool.color.set(cool);
        mats.colCool.emissive.set(cool);
        mats.colSteel.color.set(steel);
        particleMat.color.set(particle);
        groundMat.color.set(particle);
        ringMat.color.set(particle);
    }

    // ---------- Dumbbell ----------
    function axisCylinder(radius, length, material, x) {
        var m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 40, 1), material);
        m.rotation.z = Math.PI / 2;      // lay the cylinder along the x axis
        m.position.x = x;
        return m;
    }

    function plateGeometry() {
        // Beveled disc of radius 1, revolved around Y, then laid on its side.
        var h = PLATE_T / 2, b = 0.05;
        var pts = [
            new THREE.Vector2(0, -h),
            new THREE.Vector2(1 - b, -h),
            new THREE.Vector2(1, -h + b),
            new THREE.Vector2(1, h - b),
            new THREE.Vector2(1 - b, h),
            new THREE.Vector2(0, h)
        ];
        return new THREE.LatheGeometry(pts, 72);
    }

    function buildDumbbell() {
        dumbGroup = new THREE.Group();
        tilt = new THREE.Group();
        spin = new THREE.Group();
        dumbGroup.add(tilt);
        tilt.add(spin);
        tilt.rotation.x = TILT_X;
        tilt.rotation.z = TILT_Z;

        // Bar (its length follows the plates)
        handle = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 6, 40, 1), mats.steel);
        handle.rotation.z = Math.PI / 2;
        spin.add(handle);

        // Grip knurling and the accent band in the middle
        var i;
        for (i = -5; i <= 5; i++) {
            if (i === 0) continue;
            spin.add(axisCylinder(0.178, 0.05, mats.dark, i * 0.19));
        }
        spin.add(axisCylinder(0.2, 0.14, mats.accent, 0));

        // Inner collars
        spin.add(axisCylinder(0.28, 0.16, mats.steel, -1.14));
        spin.add(axisCylinder(0.28, 0.16, mats.steel, 1.14));

        // Plates: four per side, scaled in and out by the goal
        var geo = plateGeometry();
        var faceGeo = new THREE.CylinderGeometry(0.72, 0.72, PLATE_T + 0.014, 56, 1);
        var side, idx, g, body, face;
        for (side = -1; side <= 1; side += 2) {
            for (idx = 0; idx < 4; idx++) {
                g = new THREE.Group();
                body = new THREE.Mesh(geo, mats.plate);
                body.rotation.z = Math.PI / 2;
                face = new THREE.Mesh(faceGeo, mats.accent);
                face.rotation.z = Math.PI / 2;
                g.add(body);
                g.add(face);
                g.position.x = side * (PLATE_START + PLATE_T / 2 + idx * PLATE_STEP);
                g.scale.set(1, 0.0001, 0.0001);
                g.visible = false;
                spin.add(g);
                plates.push({ group: g, index: idx, s: 0 });
            }
        }

        // End caps
        capL = axisCylinder(0.24, 0.16, mats.steel, -state.capX);
        capR = axisCylinder(0.24, 0.16, mats.steel, state.capX);
        spin.add(capL);
        spin.add(capR);

        scene.add(dumbGroup);
    }

    // ---------- Columns ----------
    function buildColumns() {
        colGroup = new THREE.Group();
        colGroup.visible = false;

        groundMat = new THREE.MeshBasicMaterial({
            color: 0x9aa5d6, transparent: true, opacity: 0.1, depthWrite: false
        });
        ringMat = new THREE.MeshBasicMaterial({
            color: 0x9aa5d6, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide
        });
        var disc = new THREE.Mesh(new THREE.CircleGeometry(2.05, 72), groundMat);
        disc.rotation.x = -Math.PI / 2;
        disc.position.y = -0.01;
        colGroup.add(disc);
        var ring = new THREE.Mesh(new THREE.RingGeometry(2.0, 2.05, 96), ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = -0.005;
        colGroup.add(ring);

        var bodyGeo = new THREE.CylinderGeometry(0.36, 0.36, 1, 48, 1);
        bodyGeo.translate(0, 0.5, 0);    // base sits at y = 0, so scale.y grows upward
        var capGeo = new THREE.CylinderGeometry(0.385, 0.385, 0.06, 48, 1);
        var matList = [mats.colSteel, mats.colCool, mats.colAccent];

        matList.forEach(function (mat, i) {
            var body = new THREE.Mesh(bodyGeo, mat);
            var cap = new THREE.Mesh(capGeo, mat);
            body.position.x = (i - 1) * 1.05;
            cap.position.x = (i - 1) * 1.05;
            body.scale.y = 0.0001;
            colGroup.add(body);
            colGroup.add(cap);
            cols.push({ body: body, cap: cap, h: 0, target: 0, delayUntil: 0 });
        });

        scene.add(colGroup);
    }

    // ---------- Particles ----------
    function buildParticles() {
        var count = isNarrow() ? 320 : 720;
        var pos = new Float32Array(count * 3);
        for (var i = 0; i < count; i++) {
            pos[i * 3] = (Math.random() - 0.5) * 20;
            pos[i * 3 + 1] = (Math.random() - 0.5) * 11;
            pos[i * 3 + 2] = -8 + Math.random() * 11;
        }
        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        particleMat = new THREE.PointsMaterial({
            color: 0x9aa5d6, size: 0.05, sizeAttenuation: true,
            transparent: true, opacity: 0.7, depthWrite: false
        });
        particles = new THREE.Points(geo, particleMat);
        scene.add(particles);
    }

    // ---------- Sizing and layout ----------
    function resize() {
        if (!started) return;
        var w = global.innerWidth, h = global.innerHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }

    function layout() {
        var W = global.innerWidth, H = global.innerHeight;
        var vh = 2 * CAM_Z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        var vw = vh * camera.aspect;
        var k = vh / H;                                   // world units per pixel

        var el = pickAnchor();
        var r = el ? el.getBoundingClientRect() : null;
        if (!r || r.width < 10 || r.height < 10) {
            r = { left: W / 2 - 160, top: H / 2 - 160, width: 320, height: 320 };
        }
        var wW = r.width * k, wH = r.height * k;
        var cx = ((r.left + r.width / 2) / W - 0.5) * vw;
        var cy = (0.5 - (r.top + r.height / 2) / H) * vh;
        var topY = (0.5 - r.top / H) * vh;
        var narrow = isNarrow();

        // Form: dumbbell fills the anchor
        var dS = Math.min(0.95, wW / 6.6, wH / 2.9);
        var form = { x: cx, y: cy, s: dS };

        // Results: dumbbell shrinks to the top, columns stand below it
        var res = {
            x: cx,
            y: topY - wH * (narrow ? 0.17 : 0.2),
            s: Math.min(dS * 0.62, wH * (narrow ? 0.11 : 0.16))
        };
        var cs = Math.min(1, wW / 3.7, (wH * 0.5) / (COL_MAX + 0.25));

        return {
            form: form,
            res: res,
            colX: cx,
            colY: topY - wH * (narrow ? 0.93 : 0.84),
            colS: cs
        };
    }

    // ---------- Animation ----------
    function frame(now) {
        global.requestAnimationFrame(frame);
        var dt = Math.min((now - lastTime) / 1000, 0.05);
        if (!(dt > 0)) dt = 0.016;
        lastTime = now;
        var t = now / 1000;

        // Camera parallax follows the pointer
        pointer.x += (pointer.tx - pointer.x) * ease(dt, 4);
        pointer.y += (pointer.ty - pointer.y) * ease(dt, 4);
        camera.position.x = pointer.x * 0.5 * motion;
        camera.position.y = -pointer.y * 0.3 * motion;
        camera.lookAt(0, 0, 0);

        // Blend between the form and results layouts
        var L = layout();
        var mixTarget = state.mode === 'results' ? 1 : 0;
        state.mix += (mixTarget - state.mix) * ease(dt, 5);
        if (Math.abs(mixTarget - state.mix) < 0.001) state.mix = mixTarget;

        var m = state.mix;
        var s = lerp(L.form.s, L.res.s, m);
        dumbGroup.position.set(
            lerp(L.form.x, L.res.x, m),
            lerp(L.form.y, L.res.y, m) + Math.sin(t * 0.9) * 0.05 * motion * s,
            0
        );
        dumbGroup.scale.setScalar(s);

        // Spin: drag, inertia, then a slow auto-rotation
        if (!drag.on) {
            spin.rotation.y += (drag.vy + AUTO_SPIN * motion) * dt;
            drag.vy *= Math.exp(-dt * 2.5);
            tilt.rotation.x += (TILT_X - tilt.rotation.x) * ease(dt, 1.5);
        }

        // Plates follow the goal
        var set = PLATE_SETS[state.goal] || PLATE_SETS.maintain;
        var active = 0;
        var i, p, target;
        for (i = 0; i < set.length; i++) { if (set[i] > 0) active++; }
        var kp = ease(dt, 6);
        for (i = 0; i < plates.length; i++) {
            p = plates[i];
            target = set[p.index];
            p.s += (target - p.s) * kp;
            if (Math.abs(target - p.s) < 0.002) p.s = target;
            var sc = Math.max(p.s, 0.0001);
            p.group.scale.set(1, sc, sc);
            p.group.visible = p.s > 0.02;
        }
        var capTarget = PLATE_START + active * PLATE_STEP + 0.02;
        state.capX += (capTarget - state.capX) * kp;
        capL.position.x = -(state.capX + 0.06);
        capR.position.x = state.capX + 0.06;
        handle.scale.y = ((state.capX + 0.05) * 2) / 6;

        // Columns
        var anyH = 0;
        for (i = 0; i < cols.length; i++) {
            var c = cols[i];
            if (now >= c.delayUntil) {
                c.h += (c.target - c.h) * ease(dt, 4);
                if (Math.abs(c.target - c.h) < 0.002) c.h = c.target;
            }
            c.body.scale.y = Math.max(c.h, 0.0001);
            c.cap.position.y = c.h;
            c.cap.visible = c.h > 0.01;
            anyH = Math.max(anyH, c.h);
        }
        colGroup.visible = anyH > 0.004;
        colGroup.position.set(L.colX, L.colY, 0);
        colGroup.scale.setScalar(L.colS);

        // Particles drift slowly
        particles.rotation.y = t * 0.015 * motion;
        particles.position.y = Math.sin(t * 0.2) * 0.15 * motion;

        renderer.render(scene, camera);
    }

    // ---------- Input ----------
    function bindInput() {
        canvas.addEventListener('pointerdown', function (e) {
            drag.on = true;
            drag.lx = e.clientX;
            drag.ly = e.clientY;
            drag.vy = 0;
            try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            canvas.classList.add('is-dragging');
        });
        canvas.addEventListener('pointermove', function (e) {
            if (!drag.on) return;
            var dx = e.clientX - drag.lx, dy = e.clientY - drag.ly;
            drag.lx = e.clientX;
            drag.ly = e.clientY;
            spin.rotation.y += dx * 0.011;
            drag.vy = dx * 0.011 * 60;
            tilt.rotation.x = clamp(tilt.rotation.x + dy * 0.006, -0.9, 0.9);
        });
        function end() {
            drag.on = false;
            canvas.classList.remove('is-dragging');
        }
        canvas.addEventListener('pointerup', end);
        canvas.addEventListener('pointercancel', end);
        canvas.addEventListener('lostpointercapture', end);

        global.addEventListener('pointermove', function (e) {
            pointer.tx = (e.clientX / global.innerWidth - 0.5) * 2;
            pointer.ty = (e.clientY / global.innerHeight - 0.5) * 2;
        }, { passive: true });

        global.addEventListener('resize', resize);
    }

    function watchTheme() {
        try {
            var mo = new MutationObserver(applyTheme);
            mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
            var mq = global.matchMedia('(prefers-color-scheme: dark)');
            if (mq.addEventListener) mq.addEventListener('change', applyTheme);
            else if (mq.addListener) mq.addListener(applyTheme);
        } catch (e) { /* theme changes just won't live-update */ }
    }

    // ---------- Public API ----------
    api.init = function (canvasEl) {
        if (started) return true;
        try {
            canvas = canvasEl;
            renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
            renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, isNarrow() ? 1.5 : 2));
            renderer.setClearColor(0x000000, 0);
            renderer.outputEncoding = THREE.sRGBEncoding;
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
            renderer.toneMappingExposure = 1.0;

            scene = new THREE.Scene();
            camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
            camera.position.set(0, 0, CAM_Z);

            scene.environment = buildEnvironment();
            scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x1a1e33, 0.35));
            var key = new THREE.DirectionalLight(0xffffff, 0.8);
            key.position.set(3, 5, 6);
            scene.add(key);

            buildMaterials();
            buildDumbbell();
            buildColumns();
            buildParticles();
        } catch (err) {
            if (global.console) console.warn('3D scene unavailable:', err);
            document.documentElement.classList.add('no-webgl');
            return false;
        }

        started = true;
        api.ok = true;
        applyTheme();
        watchTheme();
        bindInput();
        resize();

        // Start with the plates already in place, so the first frame isn't empty
        var set = PLATE_SETS[state.goal];
        plates.forEach(function (p) { p.s = set[p.index] * 0.4; });

        lastTime = global.performance.now();
        global.requestAnimationFrame(frame);
        return true;
    };

    api.setGoal = function (goal) {
        if (PLATE_SETS[goal]) state.goal = goal;
    };

    api.showForm = function () {
        state.mode = 'form';
        cols.forEach(function (c) { c.target = 0; });
    };

    api.showResults = function (d) {
        state.mode = 'results';
        if (d && PLATE_SETS[d.goal]) state.goal = d.goal;
        var values = [d.bmr, d.tdee, d.target];
        var top = Math.max.apply(null, values) || 1;
        var now = global.performance.now();
        cols.forEach(function (c, i) {
            c.h = 0;
            c.target = (values[i] / top) * COL_MAX;
            c.delayUntil = reduced ? 0 : now + 450 + i * 220;
        });
    };

    global.FitScene = api;
})(window);
