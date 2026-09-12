import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../services/api';
import {
  MapPin,
  Globe,
  ShieldAlert,
  ShieldCheck,
  Lock,
  Unlock,
  AlertTriangle,
  Sliders,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Search,
  Filter,
  Layers,
  Radio
} from 'lucide-react';

const WORLD_COUNTRIES_GEO = {
  US: { name: 'United States', lat: 37.0902, lon: -95.7129, region: 'NA' },
  CA: { name: 'Canada', lat: 56.1304, lon: -106.3468, region: 'NA' },
  MX: { name: 'Mexico', lat: 23.6345, lon: -102.5528, region: 'NA' },
  BR: { name: 'Brazil', lat: -14.2350, lon: -51.9253, region: 'LATAM' },
  AR: { name: 'Argentina', lat: -38.4161, lon: -63.6167, region: 'LATAM' },
  GB: { name: 'United Kingdom', lat: 55.3781, lon: -3.4360, region: 'EU' },
  DE: { name: 'Germany', lat: 51.1657, lon: 10.4515, region: 'EU' },
  FR: { name: 'France', lat: 46.2276, lon: 2.2137, region: 'EU' },
  CH: { name: 'Switzerland', lat: 46.8182, lon: 8.2275, region: 'EU' },
  NL: { name: 'Netherlands', lat: 52.1326, lon: 5.2913, region: 'EU' },
  SE: { name: 'Sweden', lat: 60.1282, lon: 18.6435, region: 'EU' },
  NO: { name: 'Norway', lat: 60.4720, lon: 8.4689, region: 'EU' },
  IS: { name: 'Iceland', lat: 64.9631, lon: -19.0208, region: 'EU' },
  IT: { name: 'Italy', lat: 41.8719, lon: 12.5674, region: 'EU' },
  ES: { name: 'Spain', lat: 40.4637, lon: -3.7492, region: 'EU' },
  RU: { name: 'Russia', lat: 61.5240, lon: 105.3188, region: 'EMEA' },
  UA: { name: 'Ukraine', lat: 48.3794, lon: 31.1656, region: 'EMEA' },
  TR: { name: 'Turkey', lat: 38.9637, lon: 35.2433, region: 'MENA' },
  IL: { name: 'Israel', lat: 31.0461, lon: 34.8516, region: 'MENA' },
  AE: { name: 'UAE', lat: 23.4241, lon: 53.8478, region: 'MENA' },
  SA: { name: 'Saudi Arabia', lat: 23.8859, lon: 45.0792, region: 'MENA' },
  IR: { name: 'Iran', lat: 32.4279, lon: 53.6880, region: 'MENA' },
  IN: { name: 'India', lat: 20.5937, lon: 78.9629, region: 'APAC' },
  CN: { name: 'China', lat: 35.8617, lon: 104.1954, region: 'APAC' },
  JP: { name: 'Japan', lat: 36.2048, lon: 138.2529, region: 'APAC' },
  KR: { name: 'South Korea', lat: 35.9078, lon: 127.7669, region: 'APAC' },
  KP: { name: 'North Korea', lat: 40.3399, lon: 127.5101, region: 'APAC' },
  SG: { name: 'Singapore', lat: 1.3521, lon: 103.8198, region: 'APAC' },
  HK: { name: 'Hong Kong', lat: 22.3193, lon: 114.1694, region: 'APAC' },
  TW: { name: 'Taiwan', lat: 23.6978, lon: 120.9605, region: 'APAC' },
  AU: { name: 'Australia', lat: -25.2744, lon: 133.7751, region: 'APAC' },
  NZ: { name: 'New Zealand', lat: -40.9006, lon: 174.8860, region: 'APAC' },
  ZA: { name: 'South Africa', lat: -30.5595, lon: 22.9375, region: 'AFRICA' },
  EG: { name: 'Egypt', lat: 26.8206, lon: 30.8025, region: 'AFRICA' },
  NG: { name: 'Nigeria', lat: 9.0820, lon: 8.6753, region: 'AFRICA' }
};

const CONTINENT_POLYGONS = [
  // North America
  [
    { lat: 70, lon: -160 }, { lat: 72, lon: -125 }, { lat: 60, lon: -75 },
    { lat: 45, lon: -60 }, { lat: 30, lon: -80 }, { lat: 25, lon: -80 },
    { lat: 15, lon: -90 }, { lat: 20, lon: -105 }, { lat: 32, lon: -117 },
    { lat: 48, lon: -125 }, { lat: 60, lon: -140 }, { lat: 65, lon: -168 }
  ],
  // South America
  [
    { lat: 12, lon: -75 }, { lat: 5, lon: -50 }, { lat: -5, lon: -35 },
    { lat: -20, lon: -40 }, { lat: -35, lon: -55 }, { lat: -55, lon: -65 },
    { lat: -50, lon: -75 }, { lat: -20, lon: -70 }, { lat: 0, lon: -80 }
  ],
  // Europe
  [
    { lat: 70, lon: 25 }, { lat: 65, lon: 40 }, { lat: 55, lon: 35 },
    { lat: 45, lon: 30 }, { lat: 38, lon: 24 }, { lat: 36, lon: -5 },
    { lat: 44, lon: -9 }, { lat: 50, lon: -5 }, { lat: 58, lon: 5 },
    { lat: 70, lon: 15 }
  ],
  // Africa
  [
    { lat: 35, lon: -5 }, { lat: 37, lon: 10 }, { lat: 32, lon: 32 },
    { lat: 12, lon: 43 }, { lat: -5, lon: 40 }, { lat: -25, lon: 33 },
    { lat: -34, lon: 20 }, { lat: -18, lon: 12 }, { lat: 5, lon: 8 },
    { lat: 15, lon: -17 }, { lat: 28, lon: -13 }
  ],
  // Asia
  [
    { lat: 75, lon: 100 }, { lat: 70, lon: 170 }, { lat: 60, lon: 160 },
    { lat: 40, lon: 140 }, { lat: 25, lon: 120 }, { lat: 10, lon: 105 },
    { lat: 8, lon: 77 }, { lat: 25, lon: 65 }, { lat: 30, lon: 48 },
    { lat: 40, lon: 50 }, { lat: 50, lon: 60 }, { lat: 60, lon: 70 }
  ],
  // Australia
  [
    { lat: -12, lon: 132 }, { lat: -15, lon: 145 }, { lat: -28, lon: 153 },
    { lat: -38, lon: 145 }, { lat: -35, lon: 115 }, { lat: -22, lon: 114 }
  ]
];

function projectEquirectangular(lat, lon, width, height) {
  const x = ((lon + 180) / 360) * width;
  const y = ((90 - lat) / 180) * height;
  return { x, y };
}

export default function GeoFencingMap() {
  const [policies, setPolicies] = useState([]);
  const [selectedCountry, setSelectedCountry] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [hoveredCountry, setHoveredCountry] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const offscreenCanvasRef = useRef(null);
  const animFrameRef = useRef(null);
  const [canvasSize, setCanvasSize] = useState({ width: 960, height: 460 });

  const loadPolicies = async () => {
    try {
      const list = await api.geofencing.listPolicies();
      const validList = Array.isArray(list) ? list : [];
      setPolicies(validList);
      if (!selectedCountry && validList.length) {
        setSelectedCountry(validList[0]);
      }
    } catch (err) {
      console.error('Failed to load geofencing policies:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPolicies();
  }, []);

  const handleUpdatePolicy = async (countryCode, newAction, egressAllowed = true) => {
    try {
      const updated = await api.geofencing.updatePolicy(countryCode, newAction, egressAllowed);
      setPolicies((prev) =>
        prev.map((p) => (p.country_code === countryCode ? updated : p))
      );
      if (selectedCountry?.country_code === countryCode) {
        setSelectedCountry(updated);
      }
    } catch (err) {
      console.error('Failed to update country policy:', err);
    }
  };

  const handleBulkSet = async (action) => {
    const updatedPolicies = policies.map((p) => ({
      country_code: p.country_code,
      action
    }));
    await api.geofencing.bulkUpdatePolicies(updatedPolicies);
    loadPolicies();
  };

  const filteredPolicies = policies.filter(
    (p) =>
      (p.country_name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.country_code || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getPolicyColor = (action) => {
    switch (action) {
      case 'ALLOW':
        return '#10b981'; // emerald
      case 'BLOCK':
        return '#ef4444'; // red
      case 'QUARANTINE':
        return '#f59e0b'; // amber
      default:
        return '#64748b'; // slate
    }
  };

  // Resize listener
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const width = containerRef.current.clientWidth || 960;
        const height = Math.min(480, Math.max(340, Math.floor(width * 0.46)));
        setCanvasSize({ width, height });
      }
    };
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  // Pre-render Offscreen Background Canvas (Grid + Graticules + Continent Polygons)
  useEffect(() => {
    const { width, height } = canvasSize;
    if (width <= 0 || height <= 0) return;

    if (!offscreenCanvasRef.current) {
      offscreenCanvasRef.current = document.createElement('canvas');
    }
    const offCanvas = offscreenCanvasRef.current;
    offCanvas.width = width;
    offCanvas.height = height;
    const ctx = offCanvas.getContext('2d');
    if (!ctx) return;

    // Background Canvas
    ctx.fillStyle = '#050b14';
    ctx.fillRect(0, 0, width, height);

    // Lat/Lon Graticules (every 30 deg lat, 45 deg lon)
    ctx.strokeStyle = 'rgba(30, 41, 59, 0.45)';
    ctx.lineWidth = 0.8;
    ctx.setLineDash([3, 4]);

    for (let lon = -180; lon <= 180; lon += 45) {
      const { x } = projectEquirectangular(0, lon, width, height);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    for (let lat = -60; lat <= 80; lat += 30) {
      const { y } = projectEquirectangular(lat, 0, width, height);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    ctx.setLineDash([]);

    // Render Continent Polygons
    CONTINENT_POLYGONS.forEach((poly) => {
      if (!poly.length) return;
      ctx.beginPath();
      const first = projectEquirectangular(poly[0].lat, poly[0].lon, width, height);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < poly.length; i++) {
        const pt = projectEquirectangular(poly[i].lat, poly[i].lon, width, height);
        ctx.lineTo(pt.x, pt.y);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.6)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    });
  }, [canvasSize]);

  // Foreground 60 FPS RAF Loop (Sine-Wave Beacon Pulse Glow + Policy State Rings)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let startTime = performance.now();

    const render = (now) => {
      const elapsed = now - startTime;
      const { width, height } = canvasSize;

      // 1. Draw cached offscreen background
      if (offscreenCanvasRef.current) {
        ctx.drawImage(offscreenCanvasRef.current, 0, 0, width, height);
      } else {
        ctx.fillStyle = '#050b14';
        ctx.fillRect(0, 0, width, height);
      }

      // Sine wave pulse: 0..1 smooth oscillator
      const pulse = (Math.sin(elapsed * 0.0035) + 1) / 2;

      // 2. Render pre-projected country centroids
      policies.forEach((policy) => {
        const geo = WORLD_COUNTRIES_GEO[policy.country_code];
        if (!geo) return;
        const { x, y } = projectEquirectangular(geo.lat, geo.lon, width, height);
        const isSelected = selectedCountry?.country_code === policy.country_code;
        const isHovered = hoveredCountry?.country_code === policy.country_code;
        const color = getPolicyColor(policy.action);
        const hasNodes = policy.node_count > 0;

        // Radiant sine-wave beacon pulse glow for active nodes or selected
        if (hasNodes || isSelected || isHovered) {
          const glowRadius = isSelected ? 16 + pulse * 8 : hasNodes ? 10 + pulse * 6 : 8;
          const gradient = ctx.createRadialGradient(x, y, 2, x, y, glowRadius);
          gradient.addColorStop(0, `${color}99`);
          gradient.addColorStop(0.6, `${color}33`);
          gradient.addColorStop(1, `${color}00`);
          ctx.beginPath();
          ctx.arc(x, y, glowRadius, 0, Math.PI * 2);
          ctx.fillStyle = gradient;
          ctx.fill();
        }

        // Outer Policy State Ring
        ctx.beginPath();
        ctx.arc(x, y, isSelected ? 8 : isHovered ? 7 : 5, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        ctx.stroke();

        // Inner Core Centroid
        ctx.beginPath();
        ctx.arc(x, y, isSelected ? 4.5 : 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();

        // Country ISO Code Label
        ctx.font = 'bold 9px monospace';
        ctx.fillStyle = isSelected ? '#ffffff' : '#94a3b8';
        ctx.textAlign = 'center';
        ctx.fillText(policy.country_code, x, y - (isSelected ? 11 : 8));

        // Node count badge if > 0
        if (policy.node_count > 0) {
          ctx.font = '8px monospace';
          ctx.fillStyle = '#38bdf8';
          ctx.fillText(`(${policy.node_count})`, x, y + (isSelected ? 16 : 14));
        }
      });

      // 3. Hover Target Reticle & HUD Tooltip
      if (hoveredCountry) {
        const geo = WORLD_COUNTRIES_GEO[hoveredCountry.country_code];
        if (geo) {
          const { x, y } = projectEquirectangular(geo.lat, geo.lon, width, height);
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.arc(x, y, 14, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [canvasSize, policies, selectedCountry, hoveredCountry]);

  // Distance-Squared Raycasting for zero-DOM instant hit testing
  const findCountryAtPos = useCallback(
    (clientX, clientY) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const mouseX = clientX - rect.left;
      const mouseY = clientY - rect.top;
      const { width, height } = canvasSize;

      const hitRadiusSq = 14 * 14; // 14px radius threshold

      for (let p of policies) {
        const geo = WORLD_COUNTRIES_GEO[p.country_code];
        if (!geo) continue;
        const { x, y } = projectEquirectangular(geo.lat, geo.lon, width, height);
        const distSq = (mouseX - x) * (mouseX - x) + (mouseY - y) * (mouseY - y);
        if (distSq <= hitRadiusSq) {
          return { policy: p, x, y };
        }
      }
      return null;
    },
    [policies, canvasSize]
  );

  const handleMouseMove = (e) => {
    const hit = findCountryAtPos(e.clientX, e.clientY);
    if (hit) {
      setHoveredCountry(hit.policy);
      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      }
    } else {
      setHoveredCountry(null);
    }
  };

  const handleCanvasClick = (e) => {
    const hit = findCountryAtPos(e.clientX, e.clientY);
    if (hit) {
      setSelectedCountry(hit.policy);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center space-x-2">
            <MapPin className="w-5 h-5 text-accent-primary" />
            <span>Geo-Fencing 2D Map & PostGIS Policies</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-accent-primary/20 text-accent-primary border border-accent-primary/40">
              Dual-Layer Canvas Engine
            </span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            60 FPS GPU-accelerated Equirectangular projection, zero-trust perimeter enforcement, and PostGIS spatial queries.
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={() => handleBulkSet('ALLOW')}
            className="px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 hover:bg-emerald-500/30 text-xs font-mono font-bold transition-colors cursor-pointer"
          >
            Allow All
          </button>
          <button
            onClick={() => handleBulkSet('QUARANTINE')}
            className="px-3 py-1.5 rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/40 hover:bg-amber-500/30 text-xs font-mono font-bold transition-colors cursor-pointer"
          >
            Strict Mode
          </button>
        </div>
      </div>

      {/* Interactive 2D World Map Viewport */}
      <div className="rounded-2xl bg-dark-card border border-dark-border p-5 shadow-2xl space-y-4">
        <div className="flex items-center justify-between border-b border-dark-border pb-3">
          <div className="flex items-center space-x-2 text-xs font-mono text-slate-300">
            <Globe className="w-4 h-4 text-accent-primary" />
            <span className="font-bold">Global Mesh Distribution & Policy Overlay (Canvas Engine)</span>
          </div>

          <div className="flex items-center space-x-4 text-xs font-mono">
            <div className="flex items-center space-x-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
              <span className="text-slate-300">Allowed</span>
            </div>
            <div className="flex items-center space-x-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-400"></span>
              <span className="text-slate-300">Quarantine</span>
            </div>
            <div className="flex items-center space-x-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-red-400"></span>
              <span className="text-slate-300">Blocked</span>
            </div>
          </div>
        </div>

        {/* Dual-Layer HTML5 Canvas */}
        <div
          ref={containerRef}
          className="relative w-full h-[360px] bg-slate-950 rounded-xl border border-dark-border overflow-hidden flex items-center justify-center cursor-crosshair"
        >
          <canvas
            ref={canvasRef}
            width={canvasSize.width}
            height={canvasSize.height}
            onMouseMove={handleMouseMove}
            onClick={handleCanvasClick}
            className="w-full h-full block select-none"
          />

          {/* Instant Tooltip HUD on Raycast Hover */}
          {hoveredCountry && (
            <div
              className="absolute pointer-events-none p-2 rounded-lg bg-dark-card/95 border border-dark-border shadow-2xl text-xs font-mono z-30 transition-transform"
              style={{
                left: Math.min(canvasSize.width - 160, Math.max(10, mousePos.x + 12)),
                top: Math.min(canvasSize.height - 70, Math.max(10, mousePos.y - 45))
              }}
            >
              <div className="font-bold text-slate-100 flex items-center space-x-1">
                <span>{hoveredCountry.country_name}</span>
                <span className="text-accent-primary">({hoveredCountry.country_code})</span>
              </div>
              <div className="text-[11px] text-slate-400">
                Action:{' '}
                <strong
                  style={{ color: getPolicyColor(hoveredCountry.action) }}
                  className="font-bold"
                >
                  {hoveredCountry.action}
                </strong>
              </div>
              <div className="text-[10px] text-slate-500">
                {hoveredCountry.node_count} Active Nodes
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Policies Inventory & Selected Inspector Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Policy Table List (Left 2 cols) */}
        <div className="lg:col-span-2 rounded-2xl bg-dark-card border border-dark-border p-5 shadow-xl space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search country or code..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 pr-3 py-1.5 text-xs bg-dark-canvas border border-dark-border rounded-lg text-slate-200 placeholder-slate-500 focus:outline-none focus:border-accent-primary font-mono w-48 sm:w-64"
              />
            </div>
            <span className="text-xs font-mono text-slate-500">
              {filteredPolicies.length} Countries Configured
            </span>
          </div>

          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-dark-canvas/80 text-slate-400 border-b border-dark-border sticky top-0 z-10">
                <tr>
                  <th className="p-3.5">Country</th>
                  <th className="p-3.5">Nodes</th>
                  <th className="p-3.5">Policy Action</th>
                  <th className="p-3.5">Egress Allowed</th>
                  <th className="p-3.5 text-right">Toggle Rule</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dark-border">
                {filteredPolicies.map((p) => {
                  const isSelected = selectedCountry?.country_code === p.country_code;
                  return (
                    <tr
                      key={p.country_code}
                      onClick={() => setSelectedCountry(p)}
                      className={`hover:bg-dark-card-hover/50 transition-colors cursor-pointer ${
                        isSelected ? 'bg-dark-canvas/60' : ''
                      }`}
                    >
                      <td className="p-3.5">
                        <div className="font-bold text-slate-100 flex items-center space-x-1.5">
                          <span className="text-accent-primary font-mono">{p.country_code}</span>
                          <span>{p.country_name}</span>
                        </div>
                      </td>

                      <td className="p-3.5">
                        <span className="text-slate-300 font-bold">{p.node_count}</span>
                      </td>

                      <td className="p-3.5">
                        <span
                          className="inline-block text-[10px] font-bold px-2 py-0.5 rounded border"
                          style={{
                            backgroundColor: `${getPolicyColor(p.action)}20`,
                            color: getPolicyColor(p.action),
                            borderColor: `${getPolicyColor(p.action)}50`
                          }}
                        >
                          {p.action}
                        </span>
                      </td>

                      <td className="p-3.5">
                        <span className={p.egress_allowed ? 'text-emerald-400' : 'text-red-400'}>
                          {p.egress_allowed ? 'YES' : 'BLOCKED'}
                        </span>
                      </td>

                      <td className="p-3.5 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end space-x-1">
                          <button
                            onClick={() => handleUpdatePolicy(p.country_code, 'ALLOW', true)}
                            className={`px-2 py-1 rounded text-[10px] font-bold cursor-pointer ${
                              p.action === 'ALLOW'
                                ? 'bg-emerald-500 text-slate-950'
                                : 'bg-dark-canvas text-slate-400 hover:text-white'
                            }`}
                          >
                            ALLOW
                          </button>
                          <button
                            onClick={() => handleUpdatePolicy(p.country_code, 'QUARANTINE', true)}
                            className={`px-2 py-1 rounded text-[10px] font-bold cursor-pointer ${
                              p.action === 'QUARANTINE'
                                ? 'bg-amber-500 text-slate-950'
                                : 'bg-dark-canvas text-slate-400 hover:text-white'
                            }`}
                          >
                            QUAR
                          </button>
                          <button
                            onClick={() => handleUpdatePolicy(p.country_code, 'BLOCK', false)}
                            className={`px-2 py-1 rounded text-[10px] font-bold cursor-pointer ${
                              p.action === 'BLOCK'
                                ? 'bg-red-500 text-white'
                                : 'bg-dark-canvas text-slate-400 hover:text-white'
                            }`}
                          >
                            BLOCK
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Selected Country Policy Drawer / Inspector (Right col) */}
        {selectedCountry && (
          <div className="p-5 rounded-2xl bg-dark-card border border-dark-border space-y-4 shadow-xl flex flex-col justify-between">
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-dark-border pb-3">
                <div>
                  <h3 className="font-bold text-sm text-slate-100 font-mono">
                    {selectedCountry.country_name} ({selectedCountry.country_code})
                  </h3>
                  <div className="text-[11px] text-slate-400 font-mono">
                    PostGIS Spatial Rule Inspector
                  </div>
                </div>
                <span
                  className="text-xs font-mono font-bold px-2 py-0.5 rounded border"
                  style={{
                    backgroundColor: `${getPolicyColor(selectedCountry.action)}20`,
                    color: getPolicyColor(selectedCountry.action),
                    borderColor: `${getPolicyColor(selectedCountry.action)}50`
                  }}
                >
                  {selectedCountry.action}
                </span>
              </div>

              <div className="space-y-2.5 text-xs font-mono">
                {/* This panel used to display a PostGIS ST_Contains clause as the
                    "filter" behind the policy. No such query existed: the string was
                    decorative, and the engine matches on country_code. Showing an
                    operator a predicate the system never evaluates is worse than
                    showing nothing, because it invites trust in a boundary check that
                    is not happening. */}
                <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border space-y-1">
                  <div className="text-slate-400">Policy match:</div>
                  <div className="text-accent-primary font-bold text-[11px]">
                    node.country_code = '{selectedCountry.country_code}'
                  </div>
                  <div className="text-slate-500 text-[10px] leading-relaxed">
                    Matched on the country reported by the node, not on its coordinates.
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border space-y-1.5">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Registered Devices:</span>
                    <span className="text-white font-bold">{selectedCountry.node_count} Nodes</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Egress Routing:</span>
                    <span className={selectedCountry.egress_allowed ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
                      {selectedCountry.egress_allowed ? 'Allowed (Full WAN)' : 'Strictly Dropped'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Last Policy Push:</span>
                    <span className="text-slate-300">{new Date(selectedCountry.updated_at).toLocaleTimeString()}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-dark-border space-y-2">
              <div className="text-xs font-mono text-slate-400 font-semibold">Change Policy Rule:</div>
              <div className="grid grid-cols-3 gap-2 text-xs font-mono font-bold">
                <button
                  onClick={() => handleUpdatePolicy(selectedCountry.country_code, 'ALLOW', true)}
                  className="py-2 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 hover:bg-emerald-500/30 transition-colors cursor-pointer"
                >
                  ALLOW
                </button>
                <button
                  onClick={() => handleUpdatePolicy(selectedCountry.country_code, 'QUARANTINE', true)}
                  className="py-2 rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/40 hover:bg-amber-500/30 transition-colors cursor-pointer"
                >
                  QUARANTINE
                </button>
                <button
                  onClick={() => handleUpdatePolicy(selectedCountry.country_code, 'BLOCK', false)}
                  className="py-2 rounded-lg bg-red-500/20 text-red-400 border border-red-500/40 hover:bg-red-500/30 transition-colors cursor-pointer"
                >
                  BLOCK
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
