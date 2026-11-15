import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { api, AuthUser } from "@/lib/api";

interface AuthContextType {
  isAuthenticated: boolean;
  user: AuthUser | null;
  login: (username: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = api.onUnauthorized(() => {
      setUser(null);
      setIsAuthenticated(false);
    });

    const initSession = async () => {
      const token = api.getToken();
      if (!token) {
        setIsAuthenticated(false);
        setUser(null);
        setLoading(false);
        return;
      }

      try {
        const currentUser = await api.getCurrentUser();
        setUser(currentUser);
        setIsAuthenticated(true);
      } catch {
        api.clearToken();
        setUser(null);
        setIsAuthenticated(false);
      } finally {
        setLoading(false);
      }
    };

    initSession();
    return unsubscribe;
  }, []);

  const login = async (username: string, password: string) => {
    await api.login({ username, password });
    const currentUser = await api.getCurrentUser().catch(() => ({
      id: "current",
      email: username.trim().toLowerCase(),
    }));
    setUser(currentUser);
    setIsAuthenticated(true);
  };

  const register = async (email: string, password: string) => {
    await api.register({ email, password });
  };

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setIsAuthenticated(false);
    }
  };

  return (
    <AuthContext.Provider value={{ isAuthenticated, user, login, register, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
