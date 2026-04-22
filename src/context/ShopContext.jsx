import { createContext, useContext, useState, useEffect } from 'react';

const ShopContext = createContext();

export function ShopProvider({ children }) {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('autosense_user');
    return saved ? JSON.parse(saved) : null;
  });

  const [vehicles, setVehicles] = useState(() => {
    const saved = localStorage.getItem('autosense_vehicles');
    return saved ? JSON.parse(saved) : [];
  });

  const [shopName, setShopName] = useState('My Workshop');

  const [feedSource, setFeedSource_] = useState(() => localStorage.getItem('autotrack_feedSource') || 'rtsp');
  const [rtspUrl, setRtspUrl_] = useState(() => {
    let saved = localStorage.getItem('autotrack_rtspUrl');
    // Migration: Fix typo 192.68 -> 192.168
    if (saved && saved.includes('192.68.29.101')) {
      saved = saved.replace('192.68.29.101', '192.168.29.101');
      localStorage.setItem('autotrack_rtspUrl', saved);
    }
    return saved || 'rtsp://admin:admin%401234@192.168.29.101:554/cam/realmonitor?channel=1&subtype=0';
  });

  const setFeedConfig = (source, url = '') => {
    localStorage.setItem('autotrack_feedSource', source);
    localStorage.setItem('autotrack_rtspUrl', url);
    setFeedSource_(source);
    setRtspUrl_(url);
  };

  // Persist data
  useEffect(() => {
    localStorage.setItem('autosense_vehicles', JSON.stringify(vehicles));
  }, [vehicles]);

  useEffect(() => {
    if (user) localStorage.setItem('autosense_user', JSON.stringify(user));
    else localStorage.removeItem('autosense_user');
  }, [user]);

  const login = async (email, password) => {
    try {
      const response = await fetch('http://localhost:8000/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || 'Login failed');
      }
      
      const user = await response.json();
      setUser(user);
      return true;
    } catch (err) {
      alert(err.message);
      return false;
    }
  };

  const signup = async (userData) => {
    try {
      const response = await fetch('http://localhost:8000/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(userData)
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || 'Registration failed');
      }
      
      // Auto-login after signup
      return await login(userData.email, userData.password);
    } catch (err) {
      alert(err.message);
      return false;
    }
  };

  const logout = () => {
    setUser(null);
  };

  const addVehicle = (vehicleData) => {
    const newVehicle = {
      ...vehicleData,
      status: 'ENTERED', // Default status when accepted
      history: [{ status: 'ENTERED', timestamp: new Date().toISOString() }],
      tenantId: user?.id || 'default'
    };
    setVehicles(prev => [newVehicle, ...prev]);
  };

  const updateVehicleStatus = (id, newStatus) => {
    setVehicles(prev => prev.map(v => 
      v.id === id ? { 
        ...v, 
        status: newStatus, 
        history: [...(v.history || []), { status: newStatus, timestamp: new Date().toISOString() }],
        lastUpdate: new Date().toISOString() 
      } : v
    ));
  };

  const updateVehicle = (id, updates) => {
    setVehicles(prev => prev.map(v => 
      v.id === id ? { ...v, ...updates } : v
    ));
  };

  const removeVehicle = (id) => {
    setVehicles(prev => prev.filter(v => v.id !== id));
  };

  return (
    <ShopContext.Provider value={{
      user,
      login,
      signup,
      logout,
      vehicles,
      addVehicle,
      updateVehicleStatus,
      updateVehicle,
      removeVehicle,
      shopName,
      feedSource,
      rtspUrl,
      setFeedConfig,
    }}>
      {children}
    </ShopContext.Provider>
  );
}

export function useShop() {
  return useContext(ShopContext);
}
