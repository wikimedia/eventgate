'use strict';

/**
 * This file contains two kafka.Producer sublclasses: a 'GuaranteedProducer' and a 'HastyProducer'
 * The difference between the two is the use of the delivery-report callback.
 * GuaranteedProducer will wait for a produce request to be returned from the Kafka broker
 * (inclulding retries) before resolving its Promise.  HastyProducer will resolve the produce
 * Promise as soon as node-rdkafka accepts the produce request, and not wait for the Kafka brokers
 * to ACK the result.
 *
 * In order to allow node-rdkafka to be an optionalDependency, if node-rdkfaka fails to be
 * required, module.exports will be null.
 */

// Originally taken from
// https://github.com/wikimedia/change-propagation/blob/06178c20779c5ff213dcfdaca92fef0072e0d469/lib/kafka_factory.js

const P     = require('bluebird');
let kafka;
try {
    kafka = require('node-rdkafka');
} catch (err) {
    // eslint-disable-next-line no-console
    console.warn('node-rdkafka could not be required. If you want to use Kafka, make sure it is installed properly.', err);
}

if (!kafka) {
    module.exports = null;
} else {
    // rdkafka log messages come out like
    // [thrd:main]:   Topic staging.test.event partition 0 Leader 1003
    // Capture the thread name and the log message out of it.
    const rdkafkaLogMessageRegex =  /^\[thrd:(.+?)\]:\s+(.*)$/;

    /**
     * Maps syslog severity levels (from rdkafka) to appropriate
     * bunyan log levels.
     */
    const syslogSeverityToBunyanMap = {
        0: 'fatal',
        1: 'fatal',
        2: 'fatal',
        3: 'error',
        4: 'warn',
        5: 'info',
        6: 'debug',
        7: 'trace'
    };

    /**
     * Registers node-rdkafka event.error and event.log events
     * to be logged appropriately by the provided bunyan logger.
     * Log events will not be logged unless event_cb: true is set
     * in kafka client config.
     * To use this well, you should also set kafka.conf.log_level (to get rdkafka to log things)
     * and/or kafka.conf.debug: broker,topic,msg (or whatever facilities you want).
     * @param {Object} kafkaClient node-rdkafka client, producer or consumer.
     * @param {Object} logger bunyan logger.
     */
    const registerKafkaLogHandler = function(kafkaClient, logger) {
        logger.trace('Registering rdkafka log handler');

        // Log rdkafka log messages at appropriate log level.
        kafkaClient.on('event.log', (rdkafkaLog) => {
        // Parse the thread name out of the message header.
            let thread = 'unknown';
            let message = rdkafkaLog.message;

            const match = rdkafkaLog.message.match(rdkafkaLogMessageRegex);
            if (match && match.length === 3) {
            // Get the first matched group as the rdkafka thread name.
                thread = match[1];
                // The second match group will contain the log message.
                message = match[2];
            }
            // Log at the appropriate bunyan severity level.
            const bunyanLogLevel = syslogSeverityToBunyanMap[rdkafkaLog.severity];
            logger[bunyanLogLevel](
                { rdkafka_facility: rdkafkaLog.fac, rdkafka_thread: thread },
                message
            );
        });

        // Log rdkafka errors at error level.
        // We wait a second before registering the error handler logger.
        // rdkafka emits a couple of harmless 'error' events during
        // initial connection to brokers that can be misleading.
        setTimeout(() => {
            kafkaClient.on('event.error', (error) => {
                logger.error({ error }, `Encountered rdkafka error event: ${error.message}`);
            });
        }, 1000);

    };

    /**
     * Uses the node-rdkafka delivery-report callback to resolve the produce call Promise
     * based on the Kafka broker delivery status.
     */
    class GuaranteedProducer extends kafka.Producer {
        /**
         * @inheritdoc
         */
        constructor(conf, topicConf) {
        // GuaranteedProducer required dr_cb is true to use delivery-report.
            conf.dr_cb = true;
            super(conf, topicConf);

            this.on('delivery-report', (err, report) => {
                const reporter = report.opaque;
                if (err) {
                    return reporter.rejecter(err);
                }
                return reporter.resolver(report);
            });
        }

        /**
         * @inheritdoc
         */
        produce(topic, partition, message, key, timestamp) {
            return new P((resolve, reject) => {
                const report = {
                    resolver: resolve,
                    rejecter: reject
                };
                try {
                    const result = super.produce(topic, partition, message, key, timestamp, report);
                    if (result !== true) {
                        process.nextTick(() => {
                            reject(result);
                        });
                    }
                } catch (e) {
                    process.nextTick(() => {
                        reject(e);
                    });
                } finally {
                // After the produce, call poll immediately to see if the produce actually finished.
                    this.poll();
                }
            });
        }
    }

    /**
     * Resolves a produce call Promise as soon as node-rdkafka accepts the produce request.
     * This producer will not wait for a delivery report for the message.
     */
    class HastyProducer extends kafka.Producer {
        /**
         * @inheritdoc
         */
        produce(topic, partition, message, key, timestamp) {
            return new P((resolve, reject) => {
                try {
                    const result = super.produce(topic, partition, message, key, timestamp);
                    if (result !== true) {
                        return reject(result);
                    }
                    return resolve(result);
                } catch (e) {
                    return reject(e);
                }
            });
        }
    }

    // Map producerType to class.
    const producerTypes = {
        guaranteed: GuaranteedProducer,
        hasty: HastyProducer
    };

    /**
     * Returns a Promise of a connected Kafka Producer ready for producing.
     * A hasty producer does not use a delivery callback, and will not wait
     * for  delivery confirmation before resolving a produce promise, while
     * a guaranteed producer type will.
     * @param {string} producerType either 'guaranteed' or 'hasty'.
     * @param {Object} config  Kafka config.  Additional custom config producer.poll.interval.ms
     *                         controls the value used for producer.setPollInterval.
     * @param {Object} topicConfig Kafka topic config.
     * @param {Object} logger bunyan logger.  If given, will be used for rdkafka event.log callback
     * @return {Promise<Object>}
     */
    const producerFactory = function(producerType = 'guaranteed', config = {}, topicConfig = {}, logger) {
        if (!Object.keys(producerTypes).includes(producerType)) {
            throw new Error(
                `Cannot instantiate producerType ${producerType},` +
            `must be one of ${Object.keys(producerTypes)}`
            );
        }
        const ProducerClass = producerTypes[producerType];

        const defaultConfig = {
            'metadata.broker.list': 'localhost:9092',
            'producer.poll.interval.ms': 100,
        };
        const defaultTopicConfig = {};

        config = Object.assign(defaultConfig, config);
        topicConfig = Object.assign(defaultTopicConfig, topicConfig);

        // Get and delete producer.poll.interval.ms from kafka conf; it is not
        // a real rdkafka config.
        const pollInterval = config['producer.poll.interval.ms'];
        delete config['producer.poll.interval.ms'];

        const producerPromise = new P((resolve, reject) => {
            const producer = new ProducerClass(defaultConfig, topicConfig);
            producer.once('event.error', reject);

            if (pollInterval) {
                producer.setPollInterval(pollInterval);
            }

            // If given a bunyan logger, use it to log rdkafka event.log events.
            if (logger) {
                registerKafkaLogHandler(producer, logger.child({ 'producer_type': producerType }));
            }

            producer.connect(undefined, (err) => {
                if (err) {
                    return reject(err);
                }
                return resolve(producer);
            });
        });

        return producerPromise;
    };

    module.exports = {
        producerFactory,
        GuaranteedProducer,
        HastyProducer
    };
}
