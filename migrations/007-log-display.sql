-- Log tab display preferences. Defaults keep the page as it was: the
-- "Entries this month" stat shown, the day-of-week column hidden on phones.
ALTER TABLE users ADD COLUMN show_entry_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN mobile_weekday INTEGER NOT NULL DEFAULT 0;
