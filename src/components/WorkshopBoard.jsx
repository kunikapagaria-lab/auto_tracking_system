import { useState } from 'react';
import { useShop } from '../context/ShopContext';
import { MoreVertical, ArrowRight, Clock, MapPin, CheckCircle, X, Car, Shield } from 'lucide-react';

export default function WorkshopBoard({ searchTerm = '' }) {
  const { user, vehicles, updateVehicleStatus, updateVehicle, removeVehicle } = useShop();
  const [selectedVehicle, setSelectedVehicle] = useState(null);

  const filteredVehicles = vehicles.filter(v => 
    v.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
    v.colorName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    v.type.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (v.status || 'ENTERED').toLowerCase().includes(searchTerm.toLowerCase())
  );

  const columns = [
    { id: 'WAITING', title: 'Waiting', icon: <Clock size={16} /> },
    { id: 'ENTERED', title: 'Entered / Workshop', icon: <MapPin size={16} /> },
    { id: 'TEMP_OUT', title: 'Temp Out', icon: <ArrowRight size={16} /> },
    { id: 'EXITED', title: 'Exited', icon: <CheckCircle size={16} /> }
  ];

  return (
    <div className="kanban-board">
      {columns.map(col => (
        <div key={col.id} className="kanban-column">
          <div className="column-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ 
                color: col.id === 'WAITING' ? 'var(--yellow-accent)' : 
                       col.id === 'ENTERED' ? 'var(--green-accent)' : 
                       col.id === 'TEMP_OUT' ? 'var(--orange-accent)' : 'var(--blue-accent)'
              }}>
                {col.icon}
              </span>
              <span className="column-title">{col.title}</span>
            </div>
            <div style={{ 
              fontSize: '0.7rem', 
              fontWeight: '800',
              background: 'rgba(255,255,255,0.05)',
              padding: '2px 8px',
              borderRadius: '9999px',
              color: 'var(--text-secondary)'
            }}>
              {filteredVehicles.filter(v => (v.status === col.id || (!v.status && col.id === 'ENTERED'))).length}
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {filteredVehicles
              .filter(v => v.status === col.id || (!v.status && col.id === 'ENTERED'))
              .map(vehicle => (
                <div key={vehicle.id} className="vehicle-card" style={{ 
                  borderTopColor: col.id === 'WAITING' ? 'var(--yellow-accent)' : 
                                 col.id === 'ENTERED' ? 'var(--green-accent)' : 
                                 col.id === 'TEMP_OUT' ? 'var(--orange-accent)' : 'var(--blue-accent)'
                }}>
                  <div 
                    onClick={() => setSelectedVehicle(vehicle)}
                    style={{ cursor: 'pointer' }}
                    title="View Details"
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '12px' }}>
                      <div>
                        <div className="card-ve-id" style={{ 
                           color: col.id === 'WAITING' ? 'var(--yellow-accent)' : 
                                  col.id === 'ENTERED' ? 'var(--green-accent)' : 
                                  col.id === 'TEMP_OUT' ? 'var(--orange-accent)' : 'var(--blue-accent)'
                        }}>
                          #{vehicle.id.split('-')[1]}
                        </div>
                        <div style={{ fontSize: '0.95rem', fontWeight: '900', color: 'white', marginTop: '2px', letterSpacing: '0.05em' }}>
                          {vehicle.licensePlate || 'PENDING'}
                        </div>
                      </div>
                      <div className="status-pill" style={{ 
                        color: col.id === 'WAITING' ? 'var(--yellow-accent)' : 
                               col.id === 'ENTERED' ? 'var(--green-accent)' : 
                               col.id === 'TEMP_OUT' ? 'var(--orange-accent)' : 'var(--blue-accent)',
                        background: 'rgba(255,255,255,0.03)',
                        padding: '2px 8px'
                      }}>
                        <div className="dot"></div>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '6px', marginTop: '16px' }}>
                    {col.id !== 'WAITING' && (
                      <button 
                        onClick={() => updateVehicleStatus(vehicle.id, 'WAITING')}
                        className="btn" style={{ fontSize: '0.65rem', padding: '6px', flex: 1 }}
                        title="Move to Waiting"
                      >
                        Wait
                      </button>
                    )}
                    {col.id !== 'ENTERED' && (
                      <button 
                        onClick={() => updateVehicleStatus(vehicle.id, 'ENTERED')}
                        className="btn primary" style={{ fontSize: '0.65rem', padding: '6px', flex: 1 }}
                        title="Move to Workshop"
                      >
                        Workshop
                      </button>
                    )}
                    {col.id !== 'TEMP_OUT' && (
                      <button 
                        onClick={() => updateVehicleStatus(vehicle.id, 'TEMP_OUT')}
                        className="btn" style={{ fontSize: '0.65rem', padding: '6px', flex: 1 }}
                        title="Temp Exit"
                      >
                        Out
                      </button>
                    )}
                    {col.id !== 'EXITED' && (
                      <button 
                        onClick={() => updateVehicleStatus(vehicle.id, 'EXITED')}
                        className="btn" style={{ fontSize: '0.65rem', padding: '6px', color: 'var(--danger-color)', borderColor: 'rgba(239, 68, 68, 0.2)' }}
                        title="Delivered"
                      >
                        Exit
                      </button>
                    )}
                  </div>
                  
                  <div style={{ 
                    marginTop: '12px', 
                    paddingTop: '12px', 
                    borderTop: '1px solid rgba(255,255,255,0.03)', 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center',
                    fontSize: '0.65rem', 
                    color: 'var(--text-secondary)',
                    fontWeight: '600'
                  }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                       <Clock size={10} /> {new Date(vehicle.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    {user?.role === 'admin' && (
                      <button 
                        onClick={() => removeVehicle(vehicle.id)} 
                        style={{ background: 'none', border: 'none', color: 'var(--danger-color)', cursor: 'pointer', fontSize: '0.6rem', opacity: 0.6 }}
                        className="hover-opacity-100"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </div>
      ))}
      {/* Vehicle Detail Modal */}
      {selectedVehicle && (
        <div 
          onClick={() => setSelectedVehicle(null)}
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)',
            zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '20px'
          }}
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="panel animate-scale-in"
            style={{ 
              width: '100%', maxWidth: '600px', background: 'var(--panel-bg)', 
              borderRadius: '20px', overflow: 'hidden', border: '1px solid var(--border-color)',
              position: 'relative', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
            }}
          >
            {/* Modal Header */}
            <div style={{ 
              padding: '1.5rem', borderBottom: '1px solid var(--border-color)', 
              display: 'flex', justifyContent: 'space-between', alignItems: 'center' 
            }}>
              <div>
                <h3 style={{ fontSize: '1.1rem', fontWeight: '900', color: 'white' }}>
                  Vehicle Details
                </h3>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  Registry Log: {selectedVehicle.id}
                </div>
              </div>
              <button 
                onClick={() => setSelectedVehicle(null)}
                style={{ background: 'rgba(255,255,255,0.05)', border: 'none', color: 'white', padding: '8px', borderRadius: '50%', cursor: 'pointer' }}
              >
                <X size={20} />
              </button>
            </div>

            {/* Modal Body */}
            <div style={{ padding: '1.5rem', maxHeight: '75vh', overflowY: 'auto' }}>
              {/* Primary Image */}
              {selectedVehicle.imageUrl ? (
                <div style={{ width: '100%', aspectRatio: '16/9', borderRadius: '12px', overflow: 'hidden', marginBottom: '1.5rem', border: '1.5px solid var(--border-color)' }}>
                  <img src={selectedVehicle.imageUrl} alt="Captured Car" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
              ) : (
                <div style={{ width: '100%', height: '200px', background: 'rgba(255,255,255,0.02)', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1.5rem' }}>
                  <Car size={32} color="var(--text-secondary)" />
                </div>
              )}

              {/* Info Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1rem', marginBottom: '1.5rem' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                  <div style={{ padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '10px' }}>
                    <div style={{ fontSize: '0.65rem', textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '800' }}>Car Colour</div>
                    <div style={{ fontWeight: '700', fontSize: '1rem' }}>{selectedVehicle.colorName} {selectedVehicle.type}</div>
                  </div>
                  <div style={{ padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '10px' }}>
                    <div style={{ fontSize: '0.65rem', textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: '4px', fontWeight: '800' }}>Current Status</div>
                    <div style={{ fontWeight: '700', fontSize: '1rem', color: 'var(--accent-color)' }}>{selectedVehicle.status || 'ENTERED'}</div>
                  </div>
                </div>
                <div style={{ padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '10px' }}>
                  <div style={{ fontSize: '0.65rem', textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: '12px', fontWeight: '800' }}>Activity History</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {(selectedVehicle.history || [{ status: 'ENTERED', timestamp: selectedVehicle.timestamp }]).map((event, idx) => (
                      <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '12px', position: 'relative' }}>
                        {idx !== (selectedVehicle.history?.length || 1) - 1 && (
                          <div style={{ position: 'absolute', left: '3.5px', top: '12px', bottom: '-12px', width: '1px', background: 'rgba(255,255,255,0.1)' }}></div>
                        )}
                        <div style={{ 
                          width: '8px', height: '8px', borderRadius: '50%', 
                          background: event.status === 'ENTERED' ? 'var(--green-accent)' : 
                                     event.status === 'TEMP_OUT' ? 'var(--orange-accent)' : 
                                     event.status === 'EXITED' ? 'var(--blue-accent)' : 'var(--yellow-accent)',
                          zIndex: 1
                        }}></div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: '700', fontSize: '0.85rem', color: 'white' }}>
                            {event.status === 'ENTERED' ? 'Entry' : 
                             event.status === 'TEMP_OUT' ? 'Temp Out' : 
                             event.status === 'EXITED' ? 'Exit' : event.status}
                          </div>
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
                            {new Date(event.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* License Plate Section */}
              <div style={{ padding: '1.25rem', background: 'rgba(59, 130, 246, 0.05)', borderRadius: '12px', border: '1px solid rgba(59, 130, 246, 0.2)', marginBottom: '1.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                  <Shield size={18} color="#3b82f6" />
                  <span style={{ fontWeight: '900', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>License Plate</span>
                </div>
                <div style={{ display: 'flex', gap: '15px', alignItems: 'center' }}>
                  {selectedVehicle.plateImageUrl ? (
                    <img src={selectedVehicle.plateImageUrl} alt="Plate Crop" style={{ height: '32px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.1)' }} />
                  ) : (
                    <div style={{ width: '60px', height: '32px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px' }}></div>
                  )}
                  <div style={{ flex: 1 }}>
                    <input 
                      type="text" 
                      value={selectedVehicle.licensePlate || ''}
                      onChange={(e) => {
                        const newPlate = e.target.value.toUpperCase();
                        updateVehicle(selectedVehicle.id, { licensePlate: newPlate });
                        setSelectedVehicle(prev => ({ ...prev, licensePlate: newPlate }));
                      }}
                      placeholder="ENTER PLATE"
                      style={{ 
                        background: 'none', border: 'none', borderBottom: '2px solid rgba(59, 130, 246, 0.3)',
                        fontSize: '1.5rem', fontWeight: '900', letterSpacing: '0.15em', color: 'white', 
                        outline: 'none', width: '100%', textShadow: '0 0 10px rgba(59, 130, 246, 0.5)'
                      }}
                    />
                    <div style={{ fontSize: '0.6rem', color: 'rgba(59, 130, 246, 0.6)', marginTop: '4px', fontWeight: '800' }}>
                      CLICK TO EDIT PLATE NUMBER
                    </div>
                  </div>
                </div>
              </div>


            </div>

            {/* Modal Footer */}
            <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end' }}>
              <button 
                onClick={() => setSelectedVehicle(null)}
                className="btn primary" style={{ padding: '10px 24px' }}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
