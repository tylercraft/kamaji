// A small router over the History API: six top-level paths, nothing nested yet.
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';

const RouteContext = createContext<{ path: string; navigate: (to: string) => void }>({
  path: '/',
  navigate: () => {},
});

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = (to: string) => {
    if (to === window.location.pathname) return;
    window.history.pushState(null, '', to);
    setPath(to);
  };
  return <RouteContext.Provider value={{ path, navigate }}>{children}</RouteContext.Provider>;
}

export const useRoute = () => useContext(RouteContext);

/** Props for an <a> that navigates in-app, leaving modified clicks (new tab) to the browser. */
export function useLink(to: string) {
  const { navigate } = useRoute();
  return {
    href: to,
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(to);
    },
  };
}
