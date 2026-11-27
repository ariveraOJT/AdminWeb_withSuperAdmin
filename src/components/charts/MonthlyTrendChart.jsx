import React from 'react';

export default function MonthlyTrendChart({ incidents, year, selectedMonth, onSelectMonth }) {
  const months = Array.from({ length: 12 }, (_, index) => ({
    date: new Date(Number(year), index, 1),
    key: `${year}-${String(index + 1).padStart(2, '0')}`,
  }));
  const monthlyCounts = Object.fromEntries(months.map(({ key }) => [key, 0]));

  incidents.forEach((inc) => {
    if (!inc.incident_date) return;
    const dateKey = String(inc.incident_date).slice(0, 7);
    if (Object.hasOwn(monthlyCounts, dateKey)) monthlyCounts[dateKey] += 1;
  });

  const maxVal = Math.max(...Object.values(monthlyCounts), 1);

  return (
    <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs">
      <div className="mb-4">
        <h4 className="text-sm font-bold text-slate-900 dark:text-white">Monthly Incident Trend</h4>
        <p className="text-xs text-slate-500">Recorded cases by month in {year}</p>
      </div>

      <div className="flex items-end justify-between gap-1 sm:gap-2">
        {months.map(({ date, key }) => {
          const count = monthlyCounts[key];
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const isSelected = selectedMonth === month;
          const heightPercent = count > 0 ? Math.max(4, (count / maxVal) * 100) : 0;

          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelectMonth(month)}
              aria-pressed={isSelected}
              aria-label={`Filter cases to ${date.toLocaleDateString('en-US', { month: 'long' })} ${year}: ${count} cases`}
              className={`min-w-0 flex-1 flex flex-col items-center gap-1.5 group rounded-lg py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${
                isSelected ? 'bg-teal-50 dark:bg-teal-950/40' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'
              }`}
            >
              <span className={`text-[11px] font-bold ${
                count > 0 ? 'text-slate-700 dark:text-slate-300' : 'text-slate-300 dark:text-slate-600'
              }`}>
                {count}
              </span>

              <div className="w-full h-32 flex items-end justify-center border-b border-slate-200 dark:border-slate-700">
                {count > 0 && (
                  <div
                    style={{ height: `${heightPercent}%` }}
                    className={`w-3/5 max-w-[36px] rounded-t transition-all duration-300 ${
                      isSelected ? 'bg-blue-700' : 'bg-teal-600 group-hover:bg-teal-500'
                    }`}
                  />
                )}
              </div>

              <span className={`text-[10px] sm:text-xs font-semibold ${
                isSelected ? 'text-teal-700 dark:text-teal-300' : 'text-slate-500 dark:text-slate-400'
              }`}>
                {date.toLocaleDateString('en-US', { month: 'short' })}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}