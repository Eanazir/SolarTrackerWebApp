// server/src/controllers/weatherController.ts
import { Request, Response } from 'express';
import pool from '../config/db.js';
import { Parser } from 'json2csv';
import * as tf from '@tensorflow/tfjs-node';
import fetch from 'node-fetch';
import { Scaler } from '../utils/scaler.js'; // Ensure correct path

// Declare global variables for model and scaler
declare global {
  var cnn_model: tf.LayersModel | undefined;
  var scaler: Scaler | undefined;
}

export const processCnnWeatherForecast = async (weatherDataId: number): Promise<{ success: boolean }> => {
  try {
    // -----------------------------
    // 1. Ensure Model and Scaler are Loaded
    // -----------------------------
    
    if (!global.cnn_model) {
      console.error('TensorFlow model is not loaded.');
      return { success: false };
    }
    if (!global.scaler) {
      console.error('Scaler is not loaded.');
      return { success: false };
    }

    // -----------------------------
    // 2. Fetch the Current Data Point
    // -----------------------------
    
    const currentDataQuery = `
      SELECT wd.*, wi.image_url
      FROM weather_data wd
      LEFT JOIN weather_images wi ON wd.id = wi.weather_data_id
      WHERE wd.id = $1
    `;
    const currentDataResult = await pool.query(currentDataQuery, [weatherDataId]);

    if (currentDataResult.rows.length === 0) {
      console.error(`No weather data found for ID ${weatherDataId}`);
      return { success: false };
    }

    const currentData = currentDataResult.rows[0];

    if (!currentData.image_url) {
      console.error(`No image URL found for weather data ID ${weatherDataId}`);
      return { success: false };
    }

    const currentTimestamp = new Date(currentData.timestamp);
    const targetTimestamp = new Date(currentTimestamp.getTime() + 5 * 60 * 1000); // 5 minutes ahead

    // -----------------------------
    // 3. Check if Forecast Already Exists
    // -----------------------------
    
    const forecastCheckQuery = `
      SELECT COUNT(*) 
      FROM cnn_forecasts 
      WHERE forecast_time = $1
    `;
    const forecastCheckResult = await pool.query(forecastCheckQuery, [targetTimestamp]);
    const forecastExists = parseInt(forecastCheckResult.rows[0].count, 10) > 0;

    if (forecastExists) {
      console.log(`Forecast already exists for ${targetTimestamp}. Skipping prediction.`);
      return { success: true }; // Forecast already exists
    }

    // -----------------------------
    // 4. Manual Timezone Handling (CST)
    // -----------------------------

    // Define CST offset (UTC-6)
    const CST_OFFSET = -6;

    // Current UTC time
    const now = new Date();

    // Convert current UTC time to CST by adding the offset
    const cstNow = new Date(now.getTime() + CST_OFFSET * 60 * 60 * 1000);

    // Start of the current day in CST
    const startOfDayCST = new Date(cstNow);
    startOfDayCST.setHours(0, 0, 0, 0);

    // End of the current day in CST
    const endOfDayCST = new Date(cstNow);
    endOfDayCST.setHours(23, 59, 59, 999);

    // Convert start and end of day back to UTC for querying
    const startOfDayUTC = new Date(startOfDayCST.getTime() - CST_OFFSET * 60 * 60 * 1000);
    const endOfDayUTC = new Date(endOfDayCST.getTime() - CST_OFFSET * 60 * 60 * 1000);

    // -----------------------------
    // 5. Fetch Data Only for Current CST Day
    // -----------------------------

    const fetchDailyDataQuery = `
      SELECT wd.*, wi.image_url
      FROM weather_data wd
      LEFT JOIN weather_images wi ON wd.id = wi.weather_data_id
      WHERE wd.timestamp >= $1 
        AND wd.timestamp <= $2
      ORDER BY wd.timestamp ASC
    `;

    const allDataResult = await pool.query(fetchDailyDataQuery, [
      startOfDayUTC.toISOString(),
      endOfDayUTC.toISOString()
    ]);

    const allData = allDataResult.rows;

    // -----------------------------
    // 6. Prepare the Input Sequence (Images Only)
    // -----------------------------

    const inputSequence: tf.Tensor[] = [];

    for (const dataPoint of allData) {
      if (!dataPoint.image_url) {
        console.error(`Missing image URL for weather data ID ${dataPoint.id}.`);
        return { success: false };
      }

      // Fetch and process the image
      const imageResponse = await fetch(dataPoint.image_url);
      if (!imageResponse.ok) {
        console.error(`Failed to fetch image from URL: ${dataPoint.image_url} for weather_data_id: ${dataPoint.id}`);
        return { success: false };
      }
      const imageBuffer = await imageResponse.arrayBuffer();
      const image = await tf.node.decodeImage(new Uint8Array(imageBuffer), 3);
      const resizedImage = tf.image.resizeBilinear(image, [299, 299]); // Adjust size if different
      const normalizedImage = resizedImage.div(255.0); // Normalize
      inputSequence.push(normalizedImage);
    }

    // Stack images into a tensor with shape [1, sequence_length, 299, 299, 3]
    const stackedImages = tf.stack(inputSequence);
    const batchedImages = stackedImages.expandDims(0); // Add batch dimension

    // -----------------------------
    // 7. Make Prediction (Images Only)
    // -----------------------------

    // Make prediction with images only
    const prediction = global.cnn_model.predict(batchedImages) as tf.Tensor;
    const forecastScaled = await prediction.array();

    // Inverse scale the prediction to get actual Lux
    let forecast = global.scaler.inverseScaleFeatures([(forecastScaled as number[][])[0][0]])[0]; // Single value
    forecast = forecast + 30000; // Adjust for actual Lux values
    console.log(`Predicted Lux for forecast_time ${targetTimestamp}: ${forecast}`);

    // -----------------------------
    // 8. Insert Forecast into Database
    // -----------------------------

    const insertForecastQuery = `
      INSERT INTO cnn_forecasts (
        weather_data_id,
        forecast_time,
        lux_forecast
      ) VALUES ($1, $2, $3)
      RETURNING id
    `;

    const forecastParams = [
      weatherDataId,
      targetTimestamp, // Forecast time
      forecast,        // Predicted Lux
    ];

    const forecastResult = await pool.query(insertForecastQuery, forecastParams);

    console.log(`Forecast processed for weather_data_id: ${weatherDataId}, Forecast ID: ${forecastResult.rows[0].id}`);

    return { success: true };
  } catch (error) {
    console.error('Error processing forecast:', error);
    return { success: false };
  }
};

export const insertWeatherDataWithImage = async (req: Request, res: Response): Promise<Response> => {
  const {
    temperature_c,
    temperature_f,
    humidity,
    wind_speed,
    wind_direction,
    timestamp,
    pressure,
    ambientWeatherBatteryOk,
    ambientWeatherTemp,
    ambientWeatherHumidity,
    ambientWeatherWindDirection,
    ambientWeatherWindSpeed,
    ambientWeatherWindMaxSpeed,
    ambientWeatherRain,
    ambientWeatherUV,
    ambientWeatherUVI,
    ambientWeatherLightLux,
  } = req.body;

  // Access the uploaded file
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'Image file is required.' });
  }

  const imageUrl = (file as Express.MulterS3.File).location;

  try {
    // Start a transaction
    await pool.query('BEGIN');

    // Insert into weather_data
    const insertWeatherText = `
        INSERT INTO weather_data (
          temperature_c,
          temperature_f,
          humidity,
          wind_speed,
          wind_direction,
          timestamp,
          pressure,
          ambientWeatherBatteryOk,
          ambientWeatherTemp,
          ambientWeatherHumidity,
          ambientWeatherWindDirection,
          ambientWeatherWindSpeed,
          ambientWeatherWindMaxSpeed,
          ambientWeatherRain,
          ambientWeatherUV,
          ambientWeatherUVI,
          ambientWeatherLightLux
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING id
      `;
    const insertWeatherValues = [
      temperature_c,
      temperature_f,
      humidity,
      wind_speed,
      wind_direction,
      timestamp,
      pressure,
      ambientWeatherBatteryOk,
      ambientWeatherTemp,
      ambientWeatherHumidity,
      ambientWeatherWindDirection,
      ambientWeatherWindSpeed,
      ambientWeatherWindMaxSpeed,
      ambientWeatherRain,
      ambientWeatherUV,
      ambientWeatherUVI,
      ambientWeatherLightLux,
    ];

    const weatherResult = await pool.query(insertWeatherText, insertWeatherValues);
    const weatherDataId = weatherResult.rows[0].id;

    // Insert into weather_images
    const insertImageText = `
        INSERT INTO weather_images (weather_data_id, image_url)
        VALUES ($1, $2)
        ON CONFLICT (weather_data_id) DO UPDATE SET image_url = EXCLUDED.image_url, timestamp = NOW()
      `;
    const insertImageValues = [weatherDataId, imageUrl];
    await pool.query(insertImageText, insertImageValues);

    // Commit the transaction
    await pool.query('COMMIT');

<<<<<<< HEAD
=======
    // Check if there are at least 5 data points for the current day
    console.log('Checking data points for forecast...');
    console.log('Timestamp:', timestamp);
    const currentDate = new Date(timestamp).toISOString().split('T')[0]; // YYYY-MM-DD
    const countQuery = `
        SELECT COUNT(*) 
        FROM weather_data 
        WHERE DATE(timestamp) = $1
    `;
    const countResult = await pool.query(countQuery, [currentDate]);
    const dataPointCount = parseInt(countResult.rows[0].count, 10);

    if (dataPointCount >= 5) {
        // Proceed to process forecast
        const forecastResponse = await processCnnWeatherForecast(weatherDataId);
        if (!forecastResponse.success) {
            console.error(`Forecast processing failed for weather_data_id: ${weatherDataId}`);
            // Optionally, you can notify the user or log this event
        }
    } else {
        console.log(`Not enough data points for ${currentDate}. Forecast skipped.`);
    }


>>>>>>> a6796a872f664b4a9adc57a6d304e2d80b5253da
    return res.status(201).json({
      message: 'Weather data and image uploaded successfully.',
      weather_data_id: weatherDataId, // Return the ID for image association
    });
<<<<<<< HEAD
=======


>>>>>>> a6796a872f664b4a9adc57a6d304e2d80b5253da
  } catch (error) {
    // Rollback the transaction in case of error
    await pool.query('ROLLBACK');
    console.error('Error inserting weather data and image:', error);
    return res.status(500).json({ error: ' Server Error' });
  }
};

// Handler to get the latest live data with image
export const getLiveData = async (req: Request, res: Response): Promise<Response> => {
  try {
    const queryText = `
      SELECT wd.*, wi.image_url
      FROM weather_data wd
      LEFT JOIN weather_images wi ON wd.id = wi.weather_data_id
      ORDER BY wd.timestamp DESC
      LIMIT 1
    `;
    const result = await pool.query(queryText);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No data found.' });
    }
    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching live data:', error);
    return res.status(500).json({ error: 'Internal Server Error, getlive' });
  }
};


// Handler to get historical data based on start and end dates
export const getHistoricalData = async (req: Request, res: Response): Promise<Response> => {
  const { startDate, endDate } = req.query;

  // Validate presence of both query parameters
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'Both startDate and endDate query parameters are required in YYYY-MM-DD format.' });
  }

  // Validate that both parameters are strings
  if (typeof startDate !== 'string' || typeof endDate !== 'string') {
    return res.status(400).json({ error: 'startDate and endDate must be strings in YYYY-MM-DD format.' });
  }

  // Validate date formats using regex (simple validation)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
    return res.status(400).json({ error: 'startDate and endDate must be in YYYY-MM-DD format.' });
  }

  // Convert to Date objects to compare
  const start = new Date(startDate);
  const end = new Date(endDate);

  // Check for invalid dates
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return res.status(400).json({ error: 'Invalid startDate or endDate.' });
  }

  // Ensure startDate is not after endDate
  if (start > end) {
    return res.status(400).json({ error: 'startDate cannot be after endDate.' });
  }

  try {
    const queryText = `
      SELECT wd.*, wi.image_url
      FROM weather_data wd
      LEFT JOIN weather_images wi ON wd.id = wi.weather_data_id
      WHERE DATE(wd.timestamp) BETWEEN $1 AND $2
      ORDER BY wd.timestamp ASC
    `;
    const result = await pool.query(queryText, [startDate, endDate]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No data found for the specified date range.' });
    }

    return res.json(result.rows);
  } catch (error) {
    console.error('Error fetching historical data:', error);
    return res.status(500).json({ error: 'Internal Server Error, getHistoricalData' });
  }
};

// Handler to export data to CSV for a date/time range
export const exportDataToCSV = async (req: Request, res: Response): Promise<Response> => {
  const { start, end } = req.query;

  if (!start || !end || typeof start !== 'string' || typeof end !== 'string') {
    return res.status(400).json({ error: 'Start and end query parameters are required in ISO format.' });
  }

  try {
    const queryText = `
      SELECT wd.*, wi.image_url
      FROM weather_data wd
      LEFT JOIN weather_images wi ON wd.id = wi.weather_data_id
      WHERE wd.timestamp BETWEEN $1 AND $2
      ORDER BY wd.timestamp ASC
    `;
    const result = await pool.query(queryText, [start, end]);

    // Convert JSON to CSV
    const fields = [
      'id',
      'temperature_c', 
      'temperature_f',
      'humidity',
      'wind_speed',
      'wind_direction',
      'timestamp',
      'pressure',
      'ambientWeatherBatteryOk',
      'ambientWeatherTemp',
      'ambientWeatherHumidity',
      'ambientWeatherWindDirection',
      'ambientWeatherWindSpeed',
      'ambientWeatherWindMaxSpeed',
      'ambientWeatherRain',
      'ambientWeatherUV',
      'ambientWeatherUVI',
      'ambientWeatherLightLux',
      'image_url',
    ];
    const json2csvParser = new Parser({ fields });
    const csv = json2csvParser.parse(result.rows);

    res.header('Content-Type', 'text/csv');
    res.attachment('weather-data.csv');
    return res.send(csv);
  } catch (error) {
    console.error('Error exporting data to CSV:', error);
    return res.status(500).json({ error: 'Internal Server Error, export' });
  }
};



export const processWeatherForecast = async (req: Request, res: Response): Promise<Response> => {
  try {
    // Start transaction
    await pool.query('BEGIN');

    // Get the last 5 inserted weather data points
    const lastDataQuery = `
      SELECT wd.*, wi.image_url
      FROM weather_data wd
      LEFT JOIN weather_images wi ON wd.id = wi.weather_data_id
      ORDER BY wd.timestamp DESC
      LIMIT 5
    `;
    const lastData = await pool.query(lastDataQuery);

    if (lastData.rows.length < 5) {
      await pool.query('ROLLBACK');
      return res.status(404).json({ error: 'Not enough weather data found' });
    }

    // Prepare input data tensor
    const inputData = lastData.rows.map(row => [
      parseFloat(row.temperature_c),
      parseFloat(row.humidity),
      parseFloat(row.pressure),
      parseFloat(row.wind_speed),
      parseFloat(row.wind_direction),
      parseFloat(row.pressure),
      parseFloat(row.ambientWeatherUV),
      parseFloat(new Date(row.timestamp).toISOString().split('T')[1].replace(/:/g, '').slice(0, 4))
    ]);

    // Load Keras model
    let model;
    try {
      model = await tf.loadLayersModel('file://server/src/model/LSTM_MODEL_5MIN.keras');
    } catch (modelError) {
      await pool.query('ROLLBACK');
      console.error('Error loading Keras model:', modelError);
      return res.status(500).json({ error: 'Error loading Keras model' });
    }

    // Get prediction
    const prediction = model.predict(tf.tensor2d(inputData)) as tf.Tensor;
    const forecastValues = await prediction.array() as number[][];

    // Destructure the inner array to get the forecast values
    const [fiveMin] = forecastValues[0];

    // Inverse transform the 5-minute forecast
    const originalFiveMin = inverseTransform([fiveMin], scalerParams)[0];

    // Insert forecasts query
    const insertForecastQuery = `
      INSERT INTO forecasts (
        forecastDate,
        "5minForecast",
        "15minForecast", 
        "30minForecast",
        "60minForecast"
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `;
    
    const forecastParams = [
      new Date(), // Current timestamp
      originalFiveMin, // Inverse transformed 5 min forecast
      0, //
      0, // 0 for now since we changed model type
      0 // 0 for now 
    ];

    const forecastResult = await pool.query(insertForecastQuery, forecastParams);

    // Commit transaction
    await pool.query('COMMIT');

    return res.status(201).json({
      message: 'Forecast processed successfully',
      forecast_id: forecastResult.rows[0].id
    });

  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error processing forecast:', error);
    return res.status(500).json({ error: 'Error processing forecast' });
  }
};

export const getLatestForecast = async (req: Request, res: Response): Promise<Response> => {
  try {
    const queryText = `
      SELECT forecastdate,
             "5minForecast",
             "15minForecast",
             "30minForecast",
             "60minForecast"
      FROM forecasts
      ORDER BY forecastdate DESC
      LIMIT 1
    `;
    const result = await pool.query(queryText);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No forecasts found.' });
    }

    return res.json({
      date: result.rows[0].date,
      '5minForecast': result.rows[0]['5minForecast'],
      '15minForecast': 0,
      '30minForecast': 0,
      '60minForecast': 0,
    });
  } catch (error) {
    console.error('Error fetching latest forecast:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

export const getLatestForecastCNN = async (req: Request, res: Response): Promise<Response> => {
  try {
        // Define CST offset constant
    const CST_OFFSET = -6; // CST is UTC-6
    
    // Get current time in CST
    const getCurrentCST = (): string => {
      const now = new Date();
      // Add CST offset hours
      const cstTime = new Date(now.getTime() + (CST_OFFSET * 60 * 60 * 1000));
      return cstTime.toISOString();
    };
    
    // Replace existing line with:
    const currentTimeCST = getCurrentCST();

    // SQL query to fetch the next forecast where forecast_time is greater than current time
    const queryText = `
      SELECT *
      FROM cnn_forecasts
      WHERE forecast_time > $1
      ORDER BY forecast_time ASC
      LIMIT 1
    `;
    const result = await pool.query(queryText, [currentTimeCST]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No upcoming forecasts found.' });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching the latest forecast:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};