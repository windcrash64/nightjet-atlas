import Icon from './Icon.jsx';

const LABELS = {
  loading: 'Checking', ok: 'Ready', partial: 'Partial results', empty: 'No options',
  not_configured: 'Compare externally', unavailable: 'Outside coverage', error: 'Try again', cancelled: 'Stopped',
};

function coverageLabel(calendar) {
  if (!calendar?.from || !Number.isInteger(calendar.days) || calendar.days < 1) return null;
  const start = new Date(`${calendar.from}T00:00:00Z`);
  if (!Number.isFinite(start.getTime())) return null;
  const end = new Date(start.getTime() + (calendar.days - 1) * 86400000);
  const format = (date) => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${format(start)}–${format(end)}`;
}

export default function SearchProgress({ providers, mode, loading, onRetry, retryIn = 0 }) {
  const visible = providers.filter((p) => mode === 'all' || (mode === 'plane' ? p.id === 'skyscanner' : mode === 'train' && p.id === 'rail'));
  if (!visible.length) return null;
  const finished = visible.filter((p) => p.status !== 'loading').length;
  return <div className="search-progress">
    <div className="search-progress-heading" role="status">
      <span>{loading ? 'Checking your options' : 'Your search connections'}</span>
      <span>{finished}/{visible.length} checked</span>
    </div>
    <div className="connection-grid">
      {visible.map((provider) => {
        const flight = provider.id === 'skyscanner';
        const pending = provider.status === 'loading';
        const retryable = ['error', 'partial', 'cancelled'].includes(provider.status);
        const dates = !flight && coverageLabel(provider.calendar);
        const message = flight && provider.status === 'not_configured'
          ? 'Live fares aren’t available here yet. Compare your route directly on the flight sites below.'
          : provider.message;
        return <article key={provider.id} className={`connection-card connection-${provider.status}`}>
          <div className="connection-title">
            <Icon name={flight ? 'plane' : 'train'} size={16} />
            <strong>{flight ? 'Flights' : 'Timetables'}</strong>
            {pending ? <span className="spinner" aria-hidden="true" /> : <span className="connection-dot" />}
          </div>
          <span className="connection-state">{LABELS[provider.status] || 'Check provider'}</span>
          <p>{message}</p>
          {dates && <small>Published rail dates: {dates}</small>}
          {retryable && !loading && <button type="button" className="text-link" disabled={retryIn > 0} onClick={() => onRetry(provider.id)}>
            {retryIn ? `Retry in ${retryIn}s` : `Retry ${flight ? 'flights' : 'timetables'}`} <Icon name="arrow" size={13} />
          </button>}
        </article>;
      })}
    </div>
  </div>;
}
