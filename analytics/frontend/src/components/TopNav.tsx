import { Link, NavLink } from "react-router-dom";

import { AccentColorPicker } from "./AccentColorPicker";
import { ThemeToggle } from "./ThemeToggle";
import styles from "./TopNav.module.css";

export function TopNav() {
  return (
    <nav className={styles.nav}>
      <div className={styles.inner}>
        <Link to="/" className={styles.brand}>iMessage Analytics</Link>
        <div className={styles.links}>
          <NavLink to="/" end className={({ isActive }) => (isActive ? styles.linkActive : styles.link)}>
            Overview
          </NavLink>
          <NavLink to="/conversations" className={({ isActive }) => (isActive ? styles.linkActive : styles.link)}>
            Conversations
          </NavLink>
          <NavLink to="/people" className={({ isActive }) => (isActive ? styles.linkActive : styles.link)}>
            People
          </NavLink>
          <NavLink to="/merge" className={({ isActive }) => (isActive ? styles.linkActive : styles.link)}>
            Merge
          </NavLink>
        </div>
        <div className={styles.controls}>
          <ThemeToggle />
          <AccentColorPicker />
        </div>
      </div>
    </nav>
  );
}
