import * as THREE from 'three';
import './style.css';

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

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2));
  renderer.setClearColor(0x0c0f14, 1);
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 80);
  camera.position.z = 5.8;

  const count = 3200;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const t = Math.random() * Math.PI * 2;
    const u = Math.random() * 2 - 1;
    const rr = Math.cbrt(Math.random()) * 2.55;
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
    uniforms: uniforms as unknown as Record<string, THREE.IUniform<number>>,
    vertexShader: `
      uniform float uTime;
      uniform float uLow;
      uniform float uHigh;
      uniform float uAmbientBreath;
      void main(){
        vec3 p = position;
        float lf = clamp(uLow + uAmbientBreath * 0.35, 0.0, 1.35);
        float hf = clamp(uHigh, 0.0, 1.35);
        float pulse = 1.0 + 0.22 * lf * sin(uTime * 1.85 + length(p)*2.35);
        float flicker = 1.0 + 0.18 * hf * sin(uTime * 6.1 + dot(p,p)*4.35);
        p *= pulse * flicker * (0.86 + uAmbientBreath * 0.25);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = mix(2.45, 3.95, lf);
      }
    `,
    fragmentShader: `
      uniform float uLow;
      uniform float uHigh;
      uniform float uTime;
      void main(){
        vec2 xy = gl_PointCoord * 2.0 - 1.0;
        float r = length(xy);
        if (r > 1.0) discard;
        float soft = pow(1.0 - smoothstep(0.45, 1.0, r), 2.05);
        float hi = clamp(uHigh, 0.0, 1.0);
        float lo = clamp(uLow, 0.0, 1.0);
        vec3 col = mix(vec3(0.075, 0.10, 0.15), vec3(0.45, 0.85, 0.95), 0.62 * lo + hi * 0.28);
        col += vec3(0.12, 0.18, 0.08) * sin(uTime + gl_PointCoord.x * 24.0) * hi;
        float a = soft * mix(0.22, 0.78, clamp(lo + hi, 0.0, 1.0));
        gl_FragColor = vec4(col, a);
      }
    `,
  });

  scene.add(new THREE.Points(geo, mat));

  let raf = 0;
  const tick = () => {
    uniforms.uTime.value += 1 / 60;
    const { low, high } = getBands();
    uniforms.uLow.value = THREE.MathUtils.lerp(uniforms.uLow.value, low, 0.18);
    uniforms.uHigh.value = THREE.MathUtils.lerp(uniforms.uHigh.value, high, 0.26);
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
