import * as THREE from 'three';
import './style.css';

/**
 * 粒子场景可调参数。
 * 算法意图见 `visual_logic.glsl`；架构说明见 `docs/ARCH_DOC.md` §2.1。
 */
const AURA_PARTICLES = {
  count: 6200,
  /** 均匀球体体积采样半径系数（与 `rr = cbrt(u)*R` 中的 R） */
  sphereRadius: 2.55,
  cameraFov: 55,
  cameraZ: 5.8,
  /** `depth01 = clamp((distCam - near) / span, 0, 1)`，驱动粒子尺度与片段虚化 */
  depthCamNear: 3.12,
  depthCamSpan: 5.35,
  /** `gl_PointSize` 基准（像素）；注入 GLSL 时经 glslFloat，避免整数字面量 */
  pointSizePxMin: 4.2,
  pointSizePxMax: 29.0,
  pointSizeGrainMin: 0.72,
  pointSizeGrainMax: 1.22,
  /** 每粒子随机发光强度（顶点 varying → 片段） */
  glowAmpMin: 0.48,
  glowAmpMax: 1.52,
} as const;

/** 注入顶点着色器的 float 字面量：`mix(4.2, 29, …)` 在 GLSL 中会因 int/float 混用编译失败，故整数须写成 `29.0`。 */
function glslFloat(n: number): string {
  const s = String(n);
  return /^[+-]?\d+$/.test(s) ? `${s}.0` : s;
}

interface HueUniforms {
  uTime: THREE.IUniform<number>;
  uLow: THREE.IUniform<number>;
  uHigh: THREE.IUniform<number>;
  uAmbientBreath: THREE.IUniform<number>;
}

export function mountAuraScene(
  mount: HTMLElement,
  getBands: () => { low: number; high: number },
  ambientOnly: () => boolean,
): () => void {
  const size = () => ({
    w: Math.max(1, mount.clientWidth),
    h: Math.max(1, mount.clientHeight),
  });

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    premultipliedAlpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.background = 'transparent';
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(AURA_PARTICLES.cameraFov, 1, 0.1, 80);
  camera.position.z = AURA_PARTICLES.cameraZ;

  const { count, sphereRadius: R } = AURA_PARTICLES;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const t = Math.random() * Math.PI * 2;
    const u = Math.random() * 2 - 1;
    const rr = Math.cbrt(Math.random()) * R;
    const s = rr * Math.sqrt(Math.max(0, 1 - u * u));
    positions[i * 3 + 0] = s * Math.cos(t);
    positions[i * 3 + 1] = rr * u;
    positions[i * 3 + 2] = s * Math.sin(t);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const uniforms: HueUniforms = {
    uTime: { value: 0 },
    uLow: { value: 0 },
    uHigh: { value: 0 },
    uAmbientBreath: { value: 0 },
  };

  const mat = new THREE.ShaderMaterial({
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    transparent: true,
    toneMapped: false,
    premultipliedAlpha: false,
    uniforms: uniforms as unknown as Record<string, THREE.IUniform<number>>,
    vertexShader: `
      uniform float uTime;
      uniform float uLow;
      uniform float uHigh;
      uniform float uAmbientBreath;
      varying float vDepth01;
      varying float vFocus;
      varying float vAtmo;
      varying float vGrain;
      varying float vGlowAmp;
      void main(){
        vec3 base = position;
        float grain = fract(sin(dot(base.xy + base.zz, vec2(127.1, 311.7))) * 43758.5453);
        float glowAmp = mix(${glslFloat(AURA_PARTICLES.glowAmpMin)}, ${glslFloat(AURA_PARTICLES.glowAmpMax)}, grain);
        float lenb = length(base);
        vec3 dir = lenb > 1e-4 ? base / lenb : vec3(0.0, 1.0, 0.0);
        float azimuth = atan(dir.z, dir.x);
        float polar = acos(clamp(dir.y, -1.0, 1.0));
        float atmo = clamp(base.y * 0.28 + 0.64, 0.0, 1.0);
        vGrain = grain;
        vGlowAmp = glowAmp;
        vAtmo = atmo;
        float rhythmA = sin(azimuth * 3.0 + uTime * 0.082);
        float rhythmB = cos(azimuth * 5.0 - uTime * 0.108);
        float rhythmC = sin(polar * 4.0 + uTime * 0.064);
        float speedMix = 0.52 + 0.48 * rhythmB;
        float radialPulse = sin(uTime * 0.098 + azimuth * 2.15 + polar * 0.9) * 0.185 * speedMix;
        vec3 tang = vec3(-dir.z, 0.0, dir.x);
        float tl = length(tang);
        tang = tl > 1e-4 ? tang / tl : vec3(1.0, 0.0, 0.0);
        float swirl = sin(uTime * 0.128 + azimuth * 4.0) * 0.195 * (0.62 + rhythmA * 0.38);
        vec3 p = base;
        p += dir * radialPulse;
        p += tang * swirl;
        p.y += cos(uTime * 0.091 + azimuth * 1.65) * 0.124 * rhythmC;
        p.x += sin(uTime * 0.105 + polar * 3.0 + rhythmA * 1.3) * 0.098;
        p.z += cos(uTime * 0.097 - polar * 2.5 + rhythmB * 1.1) * 0.092;
        float lf = clamp(uLow + uAmbientBreath * 0.35, 0.0, 1.35);
        float hf = clamp(uHigh, 0.0, 1.35);
        float breath = sin(uTime * 0.52 + lf * 2.4) * 0.5 + 0.5;
        float pulse = 1.0 + 0.38 * lf * breath * sin(uTime * 1.75 + length(p)*2.2);
        float flicker = 1.0 + 0.34 * hf * sin(uTime * 6.0 + dot(p,p)*4.2);
        float cloudBreath = 0.72 + uAmbientBreath * 0.26 + lf * 0.52;
        p *= pulse * flicker * cloudBreath;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        float distCam = length(mvPosition.xyz);
        float depth01 = clamp((distCam - ${glslFloat(AURA_PARTICLES.depthCamNear)}) / ${glslFloat(AURA_PARTICLES.depthCamSpan)}, 0.0, 1.0);
        float focus = 1.0 - depth01;
        vDepth01 = depth01;
        vFocus = focus;
        gl_Position = projectionMatrix * mvPosition;
        float dofSize = mix(${glslFloat(AURA_PARTICLES.pointSizePxMin)}, ${glslFloat(AURA_PARTICLES.pointSizePxMax)}, depth01) * mix(${glslFloat(AURA_PARTICLES.pointSizeGrainMin)}, ${glslFloat(AURA_PARTICLES.pointSizeGrainMax)}, grain);
        float audioGrow = 1.0 + 0.42 * lf * breath;
        gl_PointSize = dofSize * audioGrow * flicker * cloudBreath;
      }
    `,
    fragmentShader: `
      uniform float uLow;
      uniform float uHigh;
      uniform float uTime;
      varying float vDepth01;
      varying float vFocus;
      varying float vAtmo;
      varying float vGrain;
      varying float vGlowAmp;
      void main(){
        vec2 xy = gl_PointCoord * 2.0 - 1.0;
        float r = length(xy);
        float shell = pow(max(0.0, 1.0 - smoothstep(0.48, 1.0, r)), 0.82);
        if (shell < 0.002) discard;
        float depth01 = clamp(vDepth01, 0.0, 1.0);
        float focus = clamp(vFocus, 0.0, 1.0);
        float hi = clamp(uHigh, 0.0, 1.0);
        float lo = clamp(uLow, 0.0, 1.0);
        float breath = sin(uTime * 0.48 + lo * 2.1) * 0.5 + 0.5;
        float pulse = clamp(lo * 0.54 + hi * 0.78, 0.0, 1.0);
        float amp = vGlowAmp * mix(0.52, 1.28, pulse) * (0.9 + breath * 0.26);
        float sigma = mix(0.072, 0.158, depth01);
        float hot = exp(-(r * r) / (sigma * sigma));
        float halo = pow(max(0.0, 1.0 - r), mix(1.45, 2.65, focus));
        vec3 dust = vec3(0.91, 0.88, 0.82);
        vec3 champagne = vec3(0.945, 0.92, 0.865);
        vec3 lit = mix(dust, champagne, clamp(vAtmo * 0.38 + 0.22, 0.0, 1.0));
        float L = dot(lit, vec3(0.299, 0.587, 0.114));
        lit = mix(vec3(L), lit, 0.52);
        float bright = clamp(hot * 1.72 + halo * 0.32, 0.0, 1.0);
        vec3 whiteCore = vec3(1.0, 0.993, 0.97);
        vec3 rgb = mix(lit, whiteCore, pow(bright, 0.58) * 0.96);
        rgb *= mix(0.86, 1.12, amp);
        rgb = clamp(rgb, vec3(0.88, 0.85, 0.78), vec3(1.05, 1.02, 1.0));
        float grainMix = mix(0.94, 1.06, vGrain);
        float aHalo = halo * mix(0.075, 0.38, pulse) * shell;
        float aHot = hot * mix(0.18, 0.68, pulse) * amp * shell;
        float a = (aHalo + aHot) * grainMix * mix(0.88, 1.02, depth01);
        gl_FragColor = vec4(rgb, a);
      }
    `,
  });

  scene.add(new THREE.Points(geo, mat));

  let raf = 0;
  const tick = () => {
    uniforms.uTime.value += 1 / 60;
    const { low, high } = getBands();
    uniforms.uLow.value = THREE.MathUtils.lerp(uniforms.uLow.value, low, 0.34);
    uniforms.uHigh.value = THREE.MathUtils.lerp(uniforms.uHigh.value, high, 0.42);
    uniforms.uAmbientBreath.value = ambientOnly() ? 1 : 0;
    const { w, h } = size();
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    raf = window.requestAnimationFrame(tick);
  };
  tick();

  const ro = new ResizeObserver(() => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2));
    const { w, h } = size();
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  ro.observe(mount);

  return () => {
    window.cancelAnimationFrame(raf);
    ro.disconnect();
    geo.dispose();
    mat.dispose();
    renderer.dispose();
    mount.removeChild(renderer.domElement);
  };
}
