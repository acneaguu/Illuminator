/* Builds the settings panel from a case's control schema.
 *
 * Nothing here knows anything about batteries, solar panels or grid capacity:
 * every label, unit, range and default comes from the pack (see
 * dashboard/packs/*.yaml). Adding a tutorial should never require editing this
 * file.
 */

/** Decimal places implied by a slider's step, so 0.1 shows as "0.3" not "0.30000000004". */
function decimalsFor(step) {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

export function formatValue(control, value) {
  if (control.type === 'toggle') return value ? 'On' : 'Off';
  const places = decimalsFor(control.step ?? 1);
  return Number(value).toFixed(places);
}

function buildSlider(control, value, onInput) {
  const wrap = document.createElement('div');
  wrap.className = 'control';

  const head = document.createElement('div');
  head.className = 'control-head';

  const label = document.createElement('label');
  label.className = 'control-label';
  label.textContent = control.label;
  label.htmlFor = `control-${control.id}`;

  const readout = document.createElement('span');
  readout.className = 'control-value';
  const number = document.createElement('span');
  number.textContent = formatValue(control, value);
  readout.append(number);
  if (control.unit) {
    const unit = document.createElement('span');
    unit.className = 'unit';
    unit.textContent = control.unit;
    readout.append(unit);
  }

  head.append(label, readout);

  const input = document.createElement('input');
  input.type = 'range';
  input.id = `control-${control.id}`;
  input.min = control.min;
  input.max = control.max;
  input.step = control.step;
  input.value = value;

  const scale = document.createElement('div');
  scale.className = 'control-scale';
  const lo = document.createElement('span');
  lo.textContent = formatValue(control, control.min);
  const hi = document.createElement('span');
  hi.textContent = formatValue(control, control.max);
  scale.append(lo, hi);

  input.addEventListener('input', () => {
    const next = Number(input.value);
    number.textContent = formatValue(control, next);
    onInput(control.id, next);
  });

  wrap.append(head, input, scale);
  return wrap;
}

function buildToggle(control, value, onInput) {
  const wrap = document.createElement('div');
  wrap.className = 'control';

  const row = document.createElement('div');
  row.className = 'toggle-row';

  const label = document.createElement('label');
  label.className = 'control-label';
  label.textContent = control.label;
  label.htmlFor = `control-${control.id}`;

  const shell = document.createElement('span');
  shell.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = `control-${control.id}`;
  input.checked = Boolean(value);
  const track = document.createElement('span');
  track.className = 'slider-track';
  shell.append(input, track);

  input.addEventListener('change', () => onInput(control.id, input.checked));

  row.append(label, shell);
  wrap.append(row);
  return wrap;
}

/**
 * Render a case's controls into `container`.
 *
 * @param {HTMLElement} container
 * @param {Array} controls  control definitions from the pack
 * @param {Object} values   current value per control id
 * @param {Function} onInput called with (id, value) on every change
 * @returns {{setDisabled: Function}} handle for disabling the panel mid-run
 */
export function renderControls(container, controls, values, onInput) {
  container.replaceChildren();

  if (!controls.length) {
    const empty = document.createElement('p');
    empty.className = 'case-description';
    empty.textContent = 'This view has no adjustable settings.';
    container.append(empty);
    return { setDisabled() {} };
  }

  for (const control of controls) {
    const value = values[control.id];
    container.append(
      control.type === 'toggle'
        ? buildToggle(control, value, onInput)
        : buildSlider(control, value, onInput),
    );
  }

  return {
    setDisabled(disabled) {
      for (const input of container.querySelectorAll('input')) input.disabled = disabled;
    },
  };
}

/**
 * Render the day picker: preset buttons plus a free date field, both bounded by
 * the range of data the case actually has.
 */
export function renderDayPicker(presetRow, dateInput, daySpec, current, onChange) {
  presetRow.replaceChildren();

  const presets = daySpec.presets || {};
  for (const [name, value] of Object.entries(presets)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preset';
    button.textContent = name;
    button.dataset.day = value;
    button.setAttribute('aria-pressed', String(value === current));
    button.addEventListener('click', () => onChange(value));
    presetRow.append(button);
  }
  presetRow.classList.toggle('hidden', Object.keys(presets).length === 0);

  if (daySpec.min) dateInput.min = daySpec.min;
  if (daySpec.max) dateInput.max = daySpec.max;
  dateInput.value = current;
  dateInput.onchange = () => {
    // An out-of-range date would be rejected by the server; clamp here so the
    // user sees the correction immediately instead of an error after pressing
    // Simulate.
    let value = dateInput.value;
    if (!value) { dateInput.value = current; return; }
    if (daySpec.min && value < daySpec.min) value = daySpec.min;
    if (daySpec.max && value > daySpec.max) value = daySpec.max;
    dateInput.value = value;
    onChange(value);
  };
}

/** Reflect the selected day in the preset buttons and the date field. */
export function syncDayPicker(presetRow, dateInput, day) {
  for (const button of presetRow.querySelectorAll('.preset')) {
    button.setAttribute('aria-pressed', String(button.dataset.day === day));
  }
  dateInput.value = day;
}
