// S2 — one component per manual.kind (SPEC "Capability registry").
import TokenStep from './TokenStep.jsx';
import OAuthCodeStep from './OAuthCodeStep.jsx';
import RepoStep from './RepoStep.jsx';
import QrStep from './QrStep.jsx';
import ToggleStep from './ToggleStep.jsx';
import TakeoverStep from './TakeoverStep.jsx';
import AutoConnect from './AutoConnect.jsx';

export const STEP_FOR = {
  token: TokenStep,
  oauth: OAuthCodeStep,
  repo: RepoStep,
  qr: QrStep,
  toggle: ToggleStep,
  takeover: TakeoverStep,
};

export function stepFor(kind) {
  return STEP_FOR[kind] || TokenStep;
}

export { TokenStep, OAuthCodeStep, RepoStep, QrStep, ToggleStep, TakeoverStep, AutoConnect };
export * from './registry.js';
