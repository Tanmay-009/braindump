'use strict';

/*
 * braindump. — plain browser JavaScript
 * Sections: dates, storage, tasks, planner, timer, preferences, startup.
 * No packages, build tools, API keys, or backend are needed.
 */

// 1. DATE HELPERS
// Use local calendar dates, not UTC, so deadlines do not move a day.
function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  return year >= 1900 && year <= 9999 && dateKey(date) === value;
}

// Only supported, unambiguous expressions get a suggested date.
// Titles always retain the original words; the user confirms the suggestion.
function parseDeadline(text, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const markers = text.match(/\b(?:today|tomorrow|(?:next\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?\b/gi) || [];
  if (markers.length > 1) return '';
  if (/\b(?:next|this|coming|following)\s+(?:week|month|year)\b/i.test(text)) return '';

  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return validDate(iso[1]) ? iso[1] : '';

  // Slashed dates can mean day/month or month/day. Leave them for the picker.
  if (/\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(text)) return '';
  if (/\btomorrow\b/i.test(text)) return dateKey(addDays(today, 1));
  if (/\btoday\b/i.test(text)) return dateKey(today);

  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const weekday = text.match(/\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (weekday) {
    // "Next Friday" has multiple interpretations; require an explicit date.
    if (weekday[1]) return '';
    const offset = (weekdays.indexOf(weekday[2].toLowerCase()) - today.getDay() + 7) % 7;
    return dateKey(addDays(today, offset));
  }

  const named = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/i);
  if (named) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = months.indexOf(named[1].slice(0, 3).toLowerCase());
    const year = named[3] ? Number(named[3]) : today.getFullYear();
    const candidate = `${year}-${String(month + 1).padStart(2, '0')}-${named[2].padStart(2, '0')}`;
    // Do not silently assign next year when a yearless date has passed.
    if (!validDate(candidate) || (!named[3] && candidate < dateKey(today))) return '';
    return candidate;
  }
  return '';
}

function inferSubject(title) {
  if (/math|algebra|calculus/i.test(title)) return 'maths';
  if (/physics|chemistry|biology|science/i.test(title)) return 'science';
  if (/history/i.test(title)) return 'history';
  if (/english|essay|literature/i.test(title)) return 'english';
  return 'other';
}

function remainingSeconds(timer, now = Date.now()) {
  if (timer.endAt === null) return timer.remaining;
  return Math.max(0, Math.ceil((timer.endAt - now) / 1000));
}

// 2. APP STATE AND LOCAL SAVING
const STORAGE_KEY = 'braindump-original-v1';
const root = document.getElementById('bd-preview');
const find = (selector) => root.querySelector(selector);
const findAll = (selector) => [...root.querySelectorAll(selector)];
const originalTitle = document.title;

let tasks = [];
let settings = { nickname: '', theme: 'strawberry' };
let timer = {
  duration: 25 * 60,
  remaining: 25 * 60,
  endAt: null,
  taskTitle: 'a little space to concentrate'
};
let drafts = [];
let editingId = null;
let weekOffset = 0;
let previousTasks = null;
let currentPage = 'desk';
let storageAvailable = true;

function storageMessage(message) {
  find('#bd-storage-status').textContent = message;
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      tasks,
      settings,
      draft: find('#bd-dump').value,
      timer
    }));
    storageAvailable = true;
    storageMessage('saved in this browser');
    return true;
  } catch (error) {
    storageAvailable = false;
    storageMessage('Saving is unavailable. Keep this tab open; changes may be lost on refresh.');
    return false;
  }
}

function loadState() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    storageAvailable = false;
    storageMessage('Browser storage is blocked. Changes will last only in this tab.');
    return;
  }
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || !Array.isArray(saved.tasks)) throw new Error('Invalid data');
    tasks = saved.tasks.filter(task => task && typeof task.id === 'string' &&
      typeof task.title === 'string' && task.title.trim() && task.title.length <= 250 &&
      typeof task.due === 'string' && (!task.due || validDate(task.due)))
      .map(task => ({
        id: task.id,
        title: task.title,
        original: typeof task.original === 'string' ? task.original : task.title,
        subject: inferSubject(task.title),
        due: task.due,
        done: task.done === true
      }));
    // Ignore duplicate IDs rather than making multiple tasks respond to one edit.
    tasks = tasks.filter((task, index) => tasks.findIndex(item => item.id === task.id) === index);
    settings.nickname = typeof saved.settings?.nickname === 'string' ? saved.settings.nickname.slice(0, 30) : '';
    settings.theme = saved.settings?.theme === 'matcha' ? 'matcha' : 'strawberry';
    if (typeof saved.draft === 'string') find('#bd-dump').value = saved.draft;
    const storedTimer = saved.timer;
    if (storedTimer && [300, 900, 1500].includes(storedTimer.duration) &&
        Number.isFinite(storedTimer.remaining) && storedTimer.remaining >= 0 &&
        storedTimer.remaining <= storedTimer.duration &&
        (storedTimer.endAt === null || (Number.isFinite(storedTimer.endAt) &&
          storedTimer.endAt <= Date.now() + storedTimer.duration * 1000))) {
      timer = {
        duration: storedTimer.duration,
        remaining: Math.ceil(storedTimer.remaining),
        endAt: storedTimer.endAt,
        taskTitle: typeof storedTimer.taskTitle === 'string' ? storedTimer.taskTitle.slice(0, 250) : timer.taskTitle
      };
    }
  } catch (error) {
    storageMessage('Saved data could not be read. Your old copy stays untouched until you save a change.');
  }
}

function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Create user text with textContent, never with innerHTML.
function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function makeButton(text, onClick, className = '') {
  const button = makeElement('button', className, text);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function today() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
}

function deadlineLabel(value) {
  if (!value) return 'whenever you’re ready';
  if (value === dateKey(today())) return 'today';
  if (value === dateKey(addDays(today(), 1))) return 'tomorrow';
  return new Date(value + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function showPage(page) {
  currentPage = page;
  findAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== page; });
  findAll('[data-page]').forEach(button => {
    if (button.dataset.page === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (page === 'planner') renderPlanner();
  // Move keyboard focus into the selected page without altering tab order.
  find(`[data-panel="${page}"] h1`)?.scrollIntoView({ block: 'nearest' });
}

function showStatus(message, offerUndo = false) {
  const status = find('#bd-status');
  status.replaceChildren(document.createTextNode(message + ' '));
  if (offerUndo) {
    status.append(makeButton('undo', () => {
      if (!previousTasks) return;
      tasks = previousTasks;
      previousTasks = null;
      updateTasks();
      showStatus('Back where it was.');
    }));
  }
}

function rememberTasks() {
  previousTasks = tasks.map(task => ({ ...task }));
}

function updateTasks() {
  renderTasks();
  renderPlanner();
  saveState();
}

// 3. THE DESK: CREATE, PREVIEW, EDIT, COMPLETE, DELETE, UNDO
function renderTasks() {
  const container = find('#bd-tasks');
  container.replaceChildren();
  find('#bd-taskcount').textContent = `${tasks.filter(task => !task.done).length} on your mind`;

  tasks.forEach(task => {
    const note = makeElement('article', 'bd-note' + (task.done ? ' done' : ''));
    const top = makeElement('div', 'bd-row bd-spread');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = task.done;
    checkbox.setAttribute('aria-label', 'Complete ' + task.title);
    checkbox.addEventListener('change', () => {
      rememberTasks();
      task.done = checkbox.checked;
      updateTasks();
      find('#bd-pip-message').textContent = task.done ? 'look at you go!! one less thing.' : 'one thing at a time. i’m here.';
      showStatus(task.done ? 'one less thing on your mind ♡' : 'Back on your desk.', true);
    });
    top.append(makeElement('span', 'bd-subject', task.subject), checkbox);
    const bottom = makeElement('div', 'bd-notebottom');
    bottom.append(
      makeElement('span', '', deadlineLabel(task.due)),
      makeButton('focus ↗', () => focusOnTask(task)),
      makeButton('edit', () => editTask(task))
    );
    note.append(top, makeElement('h3', '', task.title), bottom);
    container.append(note);
  });

  if (!tasks.length) {
    const empty = makeElement('div', 'bd-empty');
    empty.append(makeElement('p', '', 'a little room for a fresh start. ♡'));
    empty.append(makeButton('try two sample tasks', loadSampleTasks));
    container.append(empty);
  }
}

function loadSampleTasks() {
  if (tasks.length) return;
  tasks = [
    { id: newId(), title: 'Maths worksheet', original: 'Maths worksheet', subject: 'maths', due: dateKey(addDays(today(), 1)), done: false },
    { id: newId(), title: 'Physics · chapter 4', original: 'Physics · chapter 4', subject: 'science', due: dateKey(addDays(today(), 2)), done: false }
  ];
  updateTasks();
  showStatus('Sample tasks added. Edit or remove them whenever you like.');
}

function editTask(task) {
  editingId = task.id;
  drafts = [{ ...task }];
  showPage('desk');
  renderReview();
}

function closeReview() {
  drafts = [];
  editingId = null;
  find('#bd-review').hidden = true;
  find('#bd-review-error').textContent = '';
}

function renderReview() {
  find('#bd-review').hidden = false;
  find('#bd-delete').hidden = editingId === null;
  find('#bd-review-error').textContent = '';
  const container = find('#bd-reviewitems');
  container.replaceChildren();

  drafts.forEach((draft, index) => {
    const row = makeElement('div', 'bd-reviewrow');
    const title = document.createElement('input');
    title.value = draft.title;
    title.maxLength = 250;
    title.setAttribute('aria-label', `Task ${index + 1} title`);
    title.addEventListener('input', () => { draft.title = title.value; });
    const date = document.createElement('input');
    date.type = 'date';
    date.min = '1900-01-01';
    date.max = '9999-12-31';
    date.value = draft.due;
    date.setAttribute('aria-label', `Task ${index + 1} due date`);
    date.addEventListener('input', () => { draft.due = date.value; });
    row.append(title, date);
    container.append(row);
  });
  find('#bd-confirm').textContent = editingId === null ? 'add to my desk' : 'save changes';
  find('#bd-review input')?.focus();
}

function untangleThoughts() {
  const lines = find('#bd-dump').value.split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) {
    showStatus('Write a thought first. Just one is enough.');
    find('#bd-dump').focus();
    return;
  }
  if (lines.length > 30 || lines.some(line => line.length > 250)) {
    showStatus('Use up to 30 thoughts, each no longer than 250 characters. Nothing was removed.');
    return;
  }
  editingId = null;
  drafts = lines.map(title => ({ title, original: title, due: parseDeadline(title), done: false }));
  renderReview();
}

function confirmTasks() {
  if (drafts.some(draft => !draft.title.trim() || draft.title.length > 250 || (draft.due && !validDate(draft.due)))) {
    find('#bd-review-error').textContent = 'Give each task a title and check its date.';
    return;
  }
  rememberTasks();
  if (editingId !== null) {
    const index = tasks.findIndex(task => task.id === editingId);
    if (index < 0) { closeReview(); return; }
    const draft = drafts[0];
    tasks[index] = { ...tasks[index], ...draft, title: draft.title.trim(), subject: inferSubject(draft.title) };
  } else {
    tasks.push(...drafts.map(draft => ({ ...draft, id: newId(), title: draft.title.trim(), subject: inferSubject(draft.title) })));
    find('#bd-dump').value = '';
  }
  closeReview();
  updateTasks();
  find('#bd-pip-message').textContent = storageAvailable ? 'got it. saved on this little desk. ♡' : 'got it. here for this visit. ♡';
  showStatus('A little more room in your head.', true);
}

function deleteTask() {
  if (editingId === null) return;
  rememberTasks();
  tasks = tasks.filter(task => task.id !== editingId);
  closeReview();
  updateTasks();
  showStatus('Removed from your desk.', true);
}

// 4. WEEKLY PLANNER — always reads the same tasks as the desk.
function renderPlanner() {
  const start = addDays(today(), -((today().getDay() + 6) % 7) + weekOffset * 7);
  const end = addDays(start, 6);
  find('#bd-weektitle').textContent = start.toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) + ' – ' +
    end.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  const container = find('#bd-week');
  container.replaceChildren();
  for (let index = 0; index < 7; index++) {
    const date = addDays(start, index);
    const cell = makeElement('div', 'bd-day' + (dateKey(date) === dateKey(today()) ? ' today' : ''));
    cell.append(
      makeElement('span', 'bd-tag', date.toLocaleDateString(undefined, { weekday: 'short' })),
      makeElement('strong', '', String(date.getDate()))
    );
    tasks.filter(task => task.due === dateKey(date)).forEach(task => {
      cell.append(makeButton((task.done ? '✓ ' : '') + task.title, () => editTask(task)));
    });
    container.append(cell);
  }
  const unscheduled = find('#bd-unscheduled');
  unscheduled.replaceChildren();
  tasks.filter(task => !task.due).forEach(task => unscheduled.append(makeButton(task.title, () => editTask(task))));
  if (!unscheduled.children.length) unscheduled.append(makeElement('p', 'bd-muted', 'Everything has a little place.'));
}

// 5. FOCUS TIMER
// endAt is a timestamp: delayed background ticks do not make the clock drift.
function paintTimer() {
  const remaining = remainingSeconds(timer);
  const minutes = String(Math.floor(remaining / 60)).padStart(2, '0');
  const seconds = String(remaining % 60).padStart(2, '0');
  find('#bd-time').textContent = `${minutes}:${seconds}`;
  find('#bd-focus-task').textContent = timer.taskTitle;
  find('#bd-timer-toggle').textContent = timer.endAt !== null ? 'pause' : remaining === 0 ? 'start again' : remaining === timer.duration ? 'start' : 'resume';
  findAll('[data-minutes]').forEach(button => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.minutes) * 60 === timer.duration));
  });
  document.title = timer.endAt !== null ? `${minutes}:${seconds} · braindump.` : originalTitle;
}

function checkTimer() {
  if (timer.endAt !== null && remainingSeconds(timer) === 0) {
    timer.remaining = 0;
    timer.endAt = null;
    find('#bd-timer-message').textContent = 'You showed up. Take a little break. ♡';
    find('#bd-pip-message').textContent = 'a little session, done. take a breath. ♡';
    // A completed focus session never completes its task automatically.
    saveState();
  }
  paintTimer();
}

function toggleTimer() {
  if (timer.endAt !== null) {
    timer.remaining = remainingSeconds(timer);
    timer.endAt = null;
  } else {
    if (timer.remaining === 0) timer.remaining = timer.duration;
    timer.endAt = Date.now() + timer.remaining * 1000;
    find('#bd-timer-message').textContent = 'one thing at a time. you’ve got this.';
  }
  saveState();
  paintTimer();
}

function resetTimer() {
  timer.endAt = null;
  timer.remaining = timer.duration;
  find('#bd-timer-message').textContent = 'a fresh little start.';
  saveState();
  paintTimer();
}

function focusOnTask(task) {
  if (timer.endAt !== null && timer.taskTitle !== task.title) {
    showPage('focus');
    find('#bd-timer-message').textContent = 'Pause your current session before choosing another task.';
    return;
  }
  timer.taskTitle = task.title;
  saveState();
  paintTimer();
  showPage('focus');
}

// 6. NICKNAME, THEME, AND SCENERY
function applyTheme(theme) {
  const matcha = theme === 'matcha';
  const palette = matcha
    ? { '--desk': '#e6eadc', '--pink': '#d8e1c6', '--rose': '#607052', '--line': '#bfc6b0' }
    : { '--desk': '#f8f6f1', '--pink': '#f6e4e2', '--rose': '#9b545c', '--line': '#e5dfd5' };
  Object.entries(palette).forEach(([property, value]) => root.style.setProperty(property, value));
  findAll('[data-theme]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.theme === theme)));
}

function updateGreeting() {
  find('#bd-pip-message').textContent = settings.nickname ? `oh, ${settings.nickname}, you’re here! ♡` : 'tiny steps count, too. ♡';
}

// 7. STARTUP AND EVENTS
function startApp() {
  loadState();
  applyTheme(settings.theme);
  find('#bd-nickname').value = settings.nickname;
  updateGreeting();
  find('#bd-dayname').textContent = today().toLocaleDateString(undefined, { weekday: 'long' });
  find('#bd-date').textContent = today().toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  renderTasks();
  checkTimer();

  findAll('[data-page]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)));
  find('#bd-untangle').addEventListener('click', untangleThoughts);
  find('#bd-add').addEventListener('click', () => {
    editingId = null;
    drafts = [{ title: '', original: '', due: '', done: false }];
    renderReview();
  });
  find('#bd-confirm').addEventListener('click', confirmTasks);
  find('#bd-cancel').addEventListener('click', closeReview);
  find('#bd-delete').addEventListener('click', deleteTask);
  find('#bd-dump').addEventListener('input', saveState);
  find('#bd-prevweek').addEventListener('click', () => { weekOffset--; renderPlanner(); });
  find('#bd-nextweek').addEventListener('click', () => { weekOffset++; renderPlanner(); });
  find('#bd-thisweek').addEventListener('click', () => { weekOffset = 0; renderPlanner(); });
  find('#bd-enter').addEventListener('click', () => showPage('focus'));
  find('#bd-timer-toggle').addEventListener('click', toggleTimer);
  find('#bd-timer-reset').addEventListener('click', resetTimer);

  findAll('[data-minutes]').forEach(button => button.addEventListener('click', () => {
    if (timer.endAt !== null) {
      find('#bd-timer-message').textContent = 'Pause the timer before changing the session length.';
      return;
    }
    timer.duration = Number(button.dataset.minutes) * 60;
    resetTimer();
  }));
  findAll('[data-scenechoice]').forEach(button => button.addEventListener('click', () => {
    find('#bd-focus-scene').dataset.scene = button.dataset.scenechoice;
    findAll('[data-scenechoice]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  }));
  findAll('[data-theme]').forEach(button => button.addEventListener('click', () => {
    settings.theme = button.dataset.theme;
    applyTheme(settings.theme);
    saveState();
  }));
  find('#bd-saveprefs').addEventListener('click', () => {
    settings.nickname = find('#bd-nickname').value.trim().slice(0, 30);
    updateGreeting();
    find('#bd-prefstatus').textContent = saveState() ? 'Your little corner is saved. ♡' : 'Applied for this visit. Browser saving is unavailable.';
  });

  // Recalculate when returning to the tab, including after the device sleeps.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      checkTimer();
      renderTasks();
      if (currentPage === 'planner') renderPlanner();
    }
  });
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY) storageMessage('Changed in another tab. Refresh before editing here to load its latest copy.');
  });
  setInterval(checkTimer, 1000);
}

startApp();
