const GITHUB = 'https://github.com/smeltjs/smelt';
const NPM = 'https://www.npmjs.com/package/@smeltjs/core';

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-iron-dark bg-charcoal/90 backdrop-blur-sm">
      <nav
        aria-label="Main"
        className="mx-auto flex h-14 max-w-[1120px] items-center gap-5 px-4 sm:h-[60px] sm:px-6"
      >
        <a href="#top" className="flex items-center gap-2.5">
          <img src={`${import.meta.env.BASE_URL}smelt-mark.svg`} alt="" width="24" height="24" />
          <span className="text-[15px] font-semibold tracking-tight text-ash">smelt</span>
        </a>
        <span className="hidden font-mono text-[12px] text-iron-light sm:inline">
          @smeltjs/core v0.2.0
        </span>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <a
            href={`${GITHUB}/blob/main/docs/ARCHITECTURE.md`}
            className="rounded-[6px] px-2.5 py-1.5 text-sm text-slag transition-colors duration-150 hover:text-ash"
          >
            Docs
          </a>
          <a
            href={NPM}
            className="rounded-[6px] px-2.5 py-1.5 text-sm text-slag transition-colors duration-150 hover:text-ash"
          >
            npm
          </a>
          <a
            href={GITHUB}
            className="rounded-[8px] border border-iron-dark px-3 py-1.5 text-sm text-ash transition-colors duration-150 hover:border-iron"
          >
            GitHub
          </a>
        </div>
      </nav>
    </header>
  );
}

export { GITHUB, NPM };
