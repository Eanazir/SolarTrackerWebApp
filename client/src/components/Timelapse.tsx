import React, { useState, useEffect } from 'react';

interface TimelapseProps {
  images: string[];
  interval?: number; 
}

const Timelapse: React.FC<TimelapseProps> = ({ images, interval = 1500 }) => {
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    if (images.length === 0 || !isPlaying) return;

    const timer = setInterval(() => {
      setCurrentImageIndex((prevIndex) => (prevIndex + 1) % images.length);
    }, interval);

    return () => clearInterval(timer);
  }, [images, interval, isPlaying]);

  const handlePlayPause = () => {
    setIsPlaying((prev) => !prev);
  };

  const handleSliderChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setCurrentImageIndex(Number(event.target.value));
  };

  if (images.length === 0) {
    return <div className="text-gray-500">No images available for timelapse.</div>;
  }

  return (
    <div className="flex flex-col items-center">
      {/* Image Display */}
      <div className="w-full max-w-2xl">
        <img
          src={images[currentImageIndex]}
          alt={`Timelapse ${currentImageIndex + 1}`}
          className="w-full h-auto rounded-md shadow-md"
          onError={(e) => {
            console.error('Error loading image:', e);
            (e.target as HTMLImageElement).src = '/path/to/fallback-image.png';
          }}
        />
      </div>

      {/* Controls */}
      <div className="mt-4 w-full max-w-2xl flex items-center justify-between">
        {/* Play/Pause Button */}
        <button
          className="bg-blue-500 text-white px-4 py-2 rounded shadow hover:bg-blue-600"
          onClick={handlePlayPause}
        >
          {isPlaying ? 'Pause' : 'Play'}
        </button>

        {/* Slider for Manual Navigation */}
        <input
          type="range"
          min="0"
          max={images.length - 1}
          value={currentImageIndex}
          onChange={handleSliderChange}
          className="w-full mx-4"
        />

        {/* Current Image Index */}
        <div className="text-gray-700 font-medium whitespace-nowrap">
          Image <span className="font-bold">{currentImageIndex + 1}</span> of{' '}
          <span className="font-bold">{images.length}</span>
        </div>
      </div>
    </div>
  );
};

export default Timelapse;